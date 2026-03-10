import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Env, AppVariables, RunRequest, WorkflowState, ResumeRequest, SSEEvent } from "../types";
import { SupervisorAgent } from "../agents/supervisor";
import { LLMClient, MODELS } from "../clients/llm";
import { WorkflowEngine } from "../workflow/engine";
import { requireScope } from "../middleware/auth";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Scope enforcement
app.use("/run", requireScope("run"));
app.use("/run/*", requireScope("run"));

// ---------------------------------------------------------------------------
// POST /v1/run — Start a new workflow
// ---------------------------------------------------------------------------
const runSchema = z.object({
  prompt: z.string().min(1).max(10000),
  tenantId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  product: z.enum(["bombastic", "costaff", "controlcenter"]).optional(),
  mode: z.enum(["full_auto", "review_before_run", "step_by_step"]).optional(),
  appetite: z.enum(["strict", "cautious", "balanced", "adventurous"]).optional(),
  context: z.record(z.unknown()).optional(),
  conversationId: z.string().regex(/^conv_[0-9a-f-]{36}$/, "Invalid conversationId format").optional(),
});

app.post("/run", async (c) => {
  const body = await c.req.json();
  const parsed = runSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const request: RunRequest = {
    ...parsed.data,
    tenantId: parsed.data.tenantId ?? c.get("tenantId"),
    userId: parsed.data.userId ?? c.get("userId"),
    product: parsed.data.product ?? c.get("product"),
  };

  try {
    const supervisor = new SupervisorAgent(c.env);
    const response = await supervisor.handleRequest(request, c.executionCtx);

    const statusCode = response.status === "failed" ? 422 : 200;
    return c.json(response, statusCode);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Internal server error", status: "failed" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/run/stream — Start a new workflow with SSE streaming
// ---------------------------------------------------------------------------
app.post("/run/stream", async (c) => {
  const body = await c.req.json();
  const parsed = runSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const request: RunRequest = {
    ...parsed.data,
    tenantId: parsed.data.tenantId ?? c.get("tenantId"),
    userId: parsed.data.userId ?? c.get("userId"),
    product: parsed.data.product ?? c.get("product"),
  };

  return streamSSE(c, async (stream) => {
    let eventId = 0;
    const onEvent = async (event: SSEEvent) => {
      await stream.writeSSE({
        event: event.event,
        data: JSON.stringify(event.data),
        id: String(eventId++),
      });
    };

    try {
      const supervisor = new SupervisorAgent(c.env);
      await supervisor.handleRequestStreaming(request, c.executionCtx, onEvent);
    } catch (err) {
      await onEvent({
        event: "error",
        data: { message: err instanceof Error ? err.message : "Internal server error" },
      });
      await onEvent({ event: "done", data: {} });
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/run/:workflowId/resume — Resume a paused workflow
// ---------------------------------------------------------------------------
const resumeSchema = z.object({
  approved: z.boolean(),
  modifiedPlan: z.any().optional(),
});

app.post("/run/:workflowId/resume", async (c) => {
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json();
  const parsed = resumeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const supervisor = new SupervisorAgent(c.env);
  const response = await supervisor.handleResume(
    workflowId,
    parsed.data.approved,
    parsed.data.modifiedPlan,
    c.executionCtx,
  );

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /v1/run/:workflowId — Get workflow status
// ---------------------------------------------------------------------------
app.get("/run/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const raw = await c.env.WORKFLOW_STATE.get(`workflow:${workflowId}`);

  if (!raw) {
    return c.json({ error: "Workflow not found" }, 404);
  }

  let state: WorkflowState = JSON.parse(raw);

  // Lazy timeout: if paused and expired, mark as timed_out
  if (
    (state.status === "paused_for_review" || state.status === "paused_at_step") &&
    state.timeoutAt &&
    new Date(state.timeoutAt).getTime() <= Date.now()
  ) {
    const engine = new WorkflowEngine(c.env);
    state = await engine.checkAndApplyTimeout(state);
  }

  return c.json(state);
});

// ---------------------------------------------------------------------------
// POST /v1/run/:workflowId/save — Save completed workflow as skill
// ---------------------------------------------------------------------------
const saveSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(10).max(2000),
  visibility: z.enum(["public", "team", "private"]).default("team"),
  tags: z.array(z.string().max(50)).max(10).optional(),
  category: z.string().max(100).optional(),
});

app.post("/run/:workflowId/save", async (c) => {
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json();
  const parsed = saveSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  try {
    const supervisor = new SupervisorAgent(c.env);
    const result = await supervisor.saveAsSkill(
      workflowId,
      c.get("tenantId"),
      c.get("userId"),
      parsed.data.name,
      parsed.data.description,
      parsed.data.visibility,
      parsed.data.tags,
      parsed.data.category,
    );
    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to save skill";
    const status = msg.includes("Unauthorized") ? 403
      : msg.includes("not found") ? 404
      : 422;
    return c.json({ error: msg }, status);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/models — List available LLM models from the proxy
// ---------------------------------------------------------------------------
app.get("/models", async (c) => {
  const llm = new LLMClient(c.env);

  try {
    const models = await llm.listModels();
    return c.json({
      models: models.map((m) => ({
        id: m.id,
        owned_by: m.owned_by,
      })),
      default: c.env.LLM_MODEL,
      aliases: MODELS,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to list models" },
      502,
    );
  }
});

export default app;
