import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { SupervisorAgent } from "../agents/supervisor";
import { requireScope } from "../middleware/auth";
import { Logger } from "../observability/logger";
import { Metrics } from "../observability/metrics";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Scope enforcement
app.use("/approvals/*", requireScope("run"));

// ---------------------------------------------------------------------------
// POST /v1/approvals/:id/approve — Approve a paused workflow
// ---------------------------------------------------------------------------
app.post("/approvals/:id/approve", async (c) => {
  const workflowId = c.req.param("id");
  const log = new Logger("supervisor", { requestId: c.get("requestId") });
  const metrics = new Metrics(c.env.ANALYTICS);
  const supervisor = new SupervisorAgent(c.env, log, metrics);

  const response = await supervisor.handleResume(workflowId, true, undefined, c.executionCtx);
  const statusCode = response.status === "failed" ? 422 : 200;
  return c.json(response, statusCode);
});

// ---------------------------------------------------------------------------
// POST /v1/approvals/:id/reject — Reject a paused workflow
// ---------------------------------------------------------------------------
app.post("/approvals/:id/reject", async (c) => {
  const workflowId = c.req.param("id");
  const log = new Logger("supervisor", { requestId: c.get("requestId") });
  const metrics = new Metrics(c.env.ANALYTICS);
  const supervisor = new SupervisorAgent(c.env, log, metrics);

  const response = await supervisor.handleResume(workflowId, false, undefined, c.executionCtx);
  const statusCode = response.status === "failed" ? 422 : 200;
  return c.json(response, statusCode);
});

export default app;
