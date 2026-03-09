import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { WorkflowRepository } from "../db/repository";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// GET /v1/sessions — List sessions for the authenticated tenant
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const status = c.req.query("status");
  const product = c.req.query("product");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

  const repo = new WorkflowRepository(c.env);
  const sessions = await repo.listSessions(
    tenantId,
    { status, product },
    limit,
    offset,
  );

  return c.json({ sessions, limit, offset });
});

// ---------------------------------------------------------------------------
// GET /v1/sessions/:id — Session detail with step executions
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const sessionId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const repo = new WorkflowRepository(c.env);
  const detail = await repo.getSessionDetail(sessionId, tenantId);

  if (!detail) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json(detail);
});

// ---------------------------------------------------------------------------
// GET /v1/sessions/:id/trace — Execution trace for Forge
// ---------------------------------------------------------------------------
app.get("/:id/trace", async (c) => {
  const sessionId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const repo = new WorkflowRepository(c.env);
  const trace = await repo.getSessionTrace(sessionId, tenantId);

  if (!trace) {
    return c.json({ error: "Trace not found" }, 404);
  }

  return c.json(trace);
});

export default app;
