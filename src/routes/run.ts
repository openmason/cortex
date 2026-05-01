import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { z } from "zod";
import type { Env, AppVariables, RunRequest, WorkflowState, ResumeRequest, StreamPart, WorkflowDAG, DAGStep } from "../types";
import { SupervisorAgent } from "../agents/supervisor";
import { LLMClient, MODELS } from "../clients/llm";
import { WorkflowEngine } from "../workflow/engine";
import { DAGWorkflowEngine } from "../workflow/dag-engine";
import { validateDAG } from "../workflow/dag";
import { requireScope } from "../middleware/auth";
import { Logger } from "../observability/logger";
import { Metrics } from "../observability/metrics";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Scope enforcement for primary /workflows routes
app.use("/workflows", requireScope("workflows"));
app.use("/workflows/*", requireScope("workflows"));

// Deprecated /run aliases — scope enforcement (backward compatibility)
app.use("/run", requireScope("workflows"));
app.use("/run/*", requireScope("workflows"));

// ---------------------------------------------------------------------------
// POST /v1/workflows — Start a new workflow (primary endpoint)
// Accepts either prompt-based request OR DAG-based request
// ---------------------------------------------------------------------------

// DAG step schema
const dagStepSchema = z.object({
  id: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  binding: z.enum(["static", "dynamic"]),
  skillRef: z.string().min(1),
  inputMapping: z.record(z.unknown()).optional(),
  condition: z.object({
    type: z.enum(["expression", "jmespath"]),
    expr: z.string(),
  }).optional(),
  onError: z.enum(["fail", "skip", "retry"]).default("fail"),
  retry: z.object({
    count: z.number().int().min(1).max(10),
    delayMs: z.number().int().min(100).max(60000),
    backoff: z.enum(["linear", "exponential"]).optional(),
  }).optional(),
  requiresApproval: z.boolean().optional(),
});

// DAG workflow schema (spec v2.0)
const dagSchema = z.object({
  id: z.string().optional(),
  steps: z.array(dagStepSchema).min(1),
  mode: z.enum(["full_auto", "review_before_run", "step_by_step"]).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

// Legacy prompt-based schema
const promptSchema = z.object({
  prompt: z.string().min(1).max(10000),
  tenantId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  product: z.enum(["bombastic", "costaff", "controlcenter"]).optional(),
  mode: z.enum(["full_auto", "review_before_run", "step_by_step"]).optional(),
  appetite: z.enum(["strict", "cautious", "balanced", "adventurous"]).optional(),
  context: z.record(z.unknown()).optional(),
  conversationId: z.string().regex(/^conv_[0-9a-f-]{36}$/, "Invalid conversationId format").optional(),
  stream: z.boolean().optional(),
  model: z.string().min(1).max(100).optional(),
  systemInstructions: z.string().max(5000).optional(),
});

// Combined schema — accepts either DAG or prompt
const runSchema = z.union([
  // DAG-based request (spec v2.0)
  z.object({
    dag: dagSchema,
    productId: z.string().min(1).optional(),
    tenantId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
    productItemId: z.string().optional(),
    callbackUrl: z.string().url().optional(),
    stream: z.boolean().optional(),
    /** Workflow-level context (secrets, shared variables) - accessible via $context.key in inputMapping */
    context: z.record(z.unknown()).optional(),
  }),
  // Prompt-based request (legacy, still supported)
  promptSchema,
]);

app.post("/workflows", async (c) => {
  const body = await c.req.json();
  const parsed = runSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const wantsStream = parsed.data.stream === true || c.req.header("Accept")?.includes("text/event-stream");

  // Detect DAG vs prompt request
  const isDAGRequest = "dag" in parsed.data;

  if (isDAGRequest) {
    // ---------------------------------------------------------------------------
    // DAG-based execution (spec v2.0)
    // ---------------------------------------------------------------------------
    const dagData = parsed.data as { dag: z.infer<typeof dagSchema>; tenantId?: string; userId?: string; productId?: string; productItemId?: string; callbackUrl?: string; stream?: boolean; context?: Record<string, unknown> };
    const tenantId = dagData.tenantId ?? c.get("tenantId");
    const userId = dagData.userId ?? c.get("userId");
    const product = dagData.productId ?? c.get("product") ?? "bombastic";

    // Build the WorkflowDAG
    const dag: WorkflowDAG = {
      id: dagData.dag.id ?? crypto.randomUUID(),
      steps: dagData.dag.steps.map((s) => ({
        ...s,
        status: "pending" as const,
      })) as DAGStep[],
      mode: dagData.dag.mode ?? "review_before_run",
      createdAt: new Date().toISOString(),
      name: dagData.dag.name,
      description: dagData.dag.description,
    };

    // Validate DAG structure
    const validation = validateDAG(dag);
    if (!validation.valid) {
      return c.json({ error: "Invalid DAG", details: validation.errors }, 400);
    }

    const log = new Logger("dag-engine", {
      requestId: c.get("requestId"),
      tenantId,
      product,
    });
    const metrics = new Metrics(c.env.ANALYTICS);

    const dagContext = {
      tenantId,
      userId,
      product: product as "bombastic" | "costaff" | "controlcenter",
      appetite: "balanced" as const,
      mode: dag.mode,
      context: dagData.context,
      callbackUrl: dagData.callbackUrl,
    };

    // SSE streaming for DAG execution
    if (wantsStream) {
      c.header("x-vercel-ai-ui-message-stream", "v1");
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");

      return honoStream(c, async (stream) => {
        const onEvent = async (part: StreamPart) => {
          await stream.write(`data: ${JSON.stringify(part)}\n\n`);
        };

        try {
          const engine = new DAGWorkflowEngine(c.env, log, metrics);
          const state = await engine.executeDAG(dag, dagContext, c.executionCtx, onEvent);

          // Send final state
          await onEvent({
            type: "finish",
            finishReason: state.status === "completed" ? "stop" : state.status,
          });
        } catch (err) {
          await onEvent({
            type: "error",
            errorText: err instanceof Error ? err.message : "DAG execution failed",
          });
        }

        await stream.write(`: [DONE]\n\n`);
      });
    }

    // Non-streaming DAG execution
    try {
      const engine = new DAGWorkflowEngine(c.env, log, metrics);
      const state = await engine.executeDAG(dag, dagContext, c.executionCtx);

      const statusCode = state.status === "failed" ? 422 : 200;
      return c.json({
        workflowId: state.workflowId,
        status: state.status,
        dag,
        outputs: state.outputs,
        createdAt: state.startedAt,
      }, statusCode);
    } catch (err) {
      log.error("DAG execution failed", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "DAG execution failed" }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt-based execution (legacy, still supported)
  // ---------------------------------------------------------------------------
  const promptData = parsed.data as z.infer<typeof promptSchema>;
  const request: RunRequest = {
    ...promptData,
    tenantId: promptData.tenantId ?? c.get("tenantId"),
    userId: promptData.userId ?? c.get("userId"),
    product: promptData.product ?? c.get("product"),
  };

  // If streaming requested, delegate to the AI SDK Data Stream path
  if (wantsStream) {
    c.header("x-vercel-ai-ui-message-stream", "v1");
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    return honoStream(c, async (stream) => {
      const onEvent = async (part: StreamPart) => {
        await stream.write(`data: ${JSON.stringify(part)}\n\n`);
      };

      try {
        const log = new Logger("supervisor", {
          requestId: c.get("requestId"),
          tenantId: request.tenantId,
          product: request.product,
        });
        const metrics = new Metrics(c.env.ANALYTICS);
        const supervisor = new SupervisorAgent(c.env, log, metrics);
        await supervisor.handleRequestStreaming(request, c.executionCtx, onEvent);
      } catch (err) {
        await onEvent({
          type: "error",
          errorText: err instanceof Error ? err.message : "Internal server error",
        });
      }

      await stream.write(`: [DONE]\n\n`);
    });
  }

  const start = Date.now();
  const log = new Logger("supervisor", {
    requestId: c.get("requestId"),
    tenantId: request.tenantId,
    product: request.product,
  });
  const metrics = new Metrics(c.env.ANALYTICS);

  try {
    const supervisor = new SupervisorAgent(c.env, log, metrics);
    const response = await supervisor.handleRequest(request, c.executionCtx);

    const statusCode = response.status === "failed" ? 422 : 200;
    metrics.write("request", {
      requestId: c.get("requestId"),
      tenantId: request.tenantId,
      product: request.product,
      status: response.status === "failed" ? "error" : "ok",
      durationMs: Date.now() - start,
    });
    return c.json(response, statusCode);
  } catch (err) {
    metrics.write("request", {
      requestId: c.get("requestId"),
      tenantId: request.tenantId,
      product: request.product,
      status: "error",
      error: err instanceof Error ? err.message : "Internal server error",
      durationMs: Date.now() - start,
    });
    return c.json(
      { error: err instanceof Error ? err.message : "Internal server error", status: "failed" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /v1/workflows/stream — Start a new workflow with AI SDK streaming (primary)
// ---------------------------------------------------------------------------
app.post("/workflows/stream", async (c) => {
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

  c.header("x-vercel-ai-ui-message-stream", "v1");
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");

  return honoStream(c, async (stream) => {
    const onEvent = async (part: StreamPart) => {
      await stream.write(`data: ${JSON.stringify(part)}\n\n`);
    };

    try {
      const log = new Logger("supervisor", {
        requestId: c.get("requestId"),
        tenantId: request.tenantId,
        product: request.product,
      });
      const metrics = new Metrics(c.env.ANALYTICS);
      const supervisor = new SupervisorAgent(c.env, log, metrics);
      await supervisor.handleRequestStreaming(request, c.executionCtx, onEvent);
    } catch (err) {
      await onEvent({
        type: "error",
        errorText: err instanceof Error ? err.message : "Internal server error",
      });
    }

    await stream.write(`: [DONE]\n\n`);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/workflows/:workflowId/resume — Resume a paused workflow (primary)
// ---------------------------------------------------------------------------
const resumeSchema = z.object({
  approved: z.boolean(),
  modifiedPlan: z.any().optional(),
  stream: z.boolean().optional(),
});

app.post("/workflows/:workflowId/resume", async (c) => {
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json();
  const parsed = resumeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const log = new Logger("engine", { requestId: c.get("requestId") });
  const metrics = new Metrics(c.env.ANALYTICS);

  // Check for DAG workflow first
  const dagEngine = new DAGWorkflowEngine(c.env, log, metrics);
  const dagState = await dagEngine.loadDAGState(workflowId);

  if (dagState) {
    // DAG workflow resume
    const wantsStream = parsed.data.stream === true || c.req.header("Accept")?.includes("text/event-stream");

    if (wantsStream) {
      c.header("x-vercel-ai-ui-message-stream", "v1");
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");

      return honoStream(c, async (stream) => {
        const onEvent = async (part: StreamPart) => {
          await stream.write(`data: ${JSON.stringify(part)}\n\n`);
        };

        try {
          const state = await dagEngine.resumeDAG(dagState, parsed.data.approved, c.executionCtx, onEvent);

          await onEvent({
            type: "finish",
            finishReason: state.status === "completed" ? "stop" : state.status,
          });
        } catch (err) {
          await onEvent({
            type: "error",
            errorText: err instanceof Error ? err.message : "DAG resume failed",
          });
        }

        await stream.write(`: [DONE]\n\n`);
      });
    }

    // Non-streaming DAG resume
    const state = await dagEngine.resumeDAG(dagState, parsed.data.approved, c.executionCtx);
    const statusCode = state.status === "failed" ? 422 : 200;
    return c.json({
      workflowId: state.workflowId,
      status: state.status,
      dag: state.dag,
      outputs: state.outputs,
      createdAt: state.startedAt,
      completedAt: state.completedAt,
      error: state.error,
    }, statusCode);
  }

  // Legacy workflow resume
  const supervisor = new SupervisorAgent(c.env, log, metrics);
  const response = await supervisor.handleResume(
    workflowId,
    parsed.data.approved,
    parsed.data.modifiedPlan,
    c.executionCtx,
  );

  const statusCode = response.status === "failed" ? 422 : 200;
  return c.json(response, statusCode);
});

// ---------------------------------------------------------------------------
// GET /v1/workflows/:workflowId — Get workflow status (primary)
// ---------------------------------------------------------------------------
app.get("/workflows/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const log = new Logger("engine", { requestId: c.get("requestId") });

  // Check for DAG workflow first
  const dagEngine = new DAGWorkflowEngine(c.env, log);
  const dagState = await dagEngine.loadDAGState(workflowId);

  if (dagState) {
    return c.json({
      workflowId: dagState.workflowId,
      status: dagState.status,
      dag: dagState.dag,
      outputs: dagState.outputs,
      createdAt: dagState.startedAt,
      completedAt: dagState.completedAt,
      error: dagState.error,
      currentLayer: dagState.currentLayer,
      pausedStepId: dagState.pausedStepId,
    });
  }

  // Legacy workflow state
  const engine = new WorkflowEngine(c.env, undefined, log);
  let state = await engine.loadState(workflowId);

  if (!state) {
    return c.json({ error: "Workflow not found" }, 404);
  }

  // Lazy timeout: if paused and expired, mark as timed_out
  if (
    (state.status === "paused_for_review" || state.status === "paused_at_step") &&
    state.timeoutAt &&
    new Date(state.timeoutAt).getTime() <= Date.now()
  ) {
    state = await engine.checkAndApplyTimeout(state);
  }

  return c.json(state);
});

// ---------------------------------------------------------------------------
// POST /v1/workflows/:workflowId/terminate — Terminate a running workflow (primary)
// ---------------------------------------------------------------------------
const terminateSchema = z.object({
  reason: z.string().max(500).optional(),
});

app.post("/workflows/:workflowId/terminate", async (c) => {
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json().catch(() => ({}));
  const parsed = terminateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const log = new Logger("engine", { requestId: c.get("requestId") });
  const metrics = new Metrics(c.env.ANALYTICS);
  const engine = new WorkflowEngine(c.env, undefined, log, metrics);
  const state = await engine.loadState(workflowId);

  if (!state) {
    return c.json({ error: "Workflow not found" }, 404);
  }

  // Check if already in terminal state
  const terminalStatuses = ["completed", "failed", "timed_out", "terminated"];
  if (terminalStatuses.includes(state.status)) {
    return c.json({
      error: `Workflow already in terminal state: ${state.status}`,
      workflowId,
      status: state.status,
    }, 409);
  }

  const terminated = await engine.terminate(state, parsed.data.reason);
  return c.json(terminated);
});

// ---------------------------------------------------------------------------
// POST /v1/workflows/:workflowId/save — Save completed workflow as skill (primary)
// ---------------------------------------------------------------------------
const saveSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(10).max(2000),
  visibility: z.enum(["public", "team", "private"]).default("team"),
  tags: z.array(z.string().max(50)).max(10).optional(),
  category: z.string().max(100).optional(),
});

app.post("/workflows/:workflowId/save", async (c) => {
  const workflowId = c.req.param("workflowId");
  const body = await c.req.json();
  const parsed = saveSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  try {
    const log = new Logger("supervisor", { requestId: c.get("requestId") });
    const supervisor = new SupervisorAgent(c.env, log);
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

// ===========================================================================
// DEPRECATED ALIASES: /run/* routes (backward compatibility)
// These will be removed in a future version. Migrate to /workflows/*
// ===========================================================================

// Deprecated: POST /v1/run → use POST /v1/workflows
app.post("/run", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows>; rel=\"successor-version\"");
  // Forward to the workflows handler
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run", "/workflows");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// Deprecated: POST /v1/run/stream → use POST /v1/workflows/stream
app.post("/run/stream", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows/stream>; rel=\"successor-version\"");
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run/stream", "/workflows/stream");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// Deprecated: GET /v1/run/:workflowId → use GET /v1/workflows/:workflowId
app.get("/run/:workflowId", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows/" + c.req.param("workflowId") + ">; rel=\"successor-version\"");
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run/", "/workflows/");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// Deprecated: POST /v1/run/:workflowId/resume → use POST /v1/workflows/:workflowId/resume
app.post("/run/:workflowId/resume", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows/" + c.req.param("workflowId") + "/resume>; rel=\"successor-version\"");
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run/", "/workflows/");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// Deprecated: POST /v1/run/:workflowId/save → use POST /v1/workflows/:workflowId/save
app.post("/run/:workflowId/save", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows/" + c.req.param("workflowId") + "/save>; rel=\"successor-version\"");
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run/", "/workflows/");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// Deprecated: POST /v1/run/:workflowId/terminate → use POST /v1/workflows/:workflowId/terminate
app.post("/run/:workflowId/terminate", async (c) => {
  c.header("Deprecation", "true");
  c.header("Link", "</v1/workflows/" + c.req.param("workflowId") + "/terminate>; rel=\"successor-version\"");
  const newUrl = new URL(c.req.url);
  newUrl.pathname = newUrl.pathname.replace("/run/", "/workflows/");
  const newReq = new Request(newUrl.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
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
        supports_tool_calls: m.supports_tool_calls,
        supports_streaming: m.supports_streaming,
        max_context_tokens: m.max_context_tokens,
        provider: m.provider,
        tier: m.tier,
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
