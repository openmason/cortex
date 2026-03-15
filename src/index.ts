import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env, AppVariables } from "./types";
import { authMiddleware, rateLimitMiddleware, usageTrackingMiddleware } from "./middleware/auth";
import runRoutes from "./routes/run";
import healthRoutes from "./routes/health";
import adminRoutes from "./routes/admin";
import analyticsRoutes from "./routes/analytics";
import sessionRoutes from "./routes/sessions";
import skillRoutes from "./routes/skills";
import chatRoutes from "./routes/chat";
import approvalRoutes from "./routes/approvals";
import demoRoutes from "./routes/demo";
import { WorkflowEngine } from "./workflow/engine";
import { DaytonaClient } from "./clients/daytona";
import { Logger } from "./observability/logger";
import { Metrics } from "./observability/metrics";

// Re-export the Durable Object class (required by wrangler)
export { WorkflowDurableObject } from "./workflow/durable-object";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.onError((err, c) => {
  const log = new Logger("cortex", { requestId: c.get("requestId") });
  log.error("Unhandled error", { error: err.message, stack: err.stack });
  return c.json(
    { error: err.message || "Internal server error", status: "failed" },
    500,
  );
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use("*", cors());
app.use("*", logger());

// Request ID — propagate or generate
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-ID") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  await next();
});

app.use("/v1/*", authMiddleware);
app.use("/v1/*", usageTrackingMiddleware);
app.use("/v1/run", rateLimitMiddleware);
app.use("/v1/run/*", rateLimitMiddleware);
app.use("/v1/chat", rateLimitMiddleware);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.route("/v1", runRoutes);
app.route("/v1", chatRoutes);
app.route("/v1", approvalRoutes);
app.route("/v1/skills", skillRoutes);
app.route("/v1/sessions", sessionRoutes);
app.route("/admin", adminRoutes);
app.route("/admin/analytics", analyticsRoutes);
app.route("/demo", demoRoutes);
app.route("/", healthRoutes);

// Root
app.get("/", (c) =>
  c.json({
    name: "cortex",
    description: "The Shared Agent Runtime",
    version: "0.1.0",
    docs: "/health",
  }),
);

// ---------------------------------------------------------------------------
// Scheduled (Cron) Handler
// ---------------------------------------------------------------------------
async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const log = new Logger("cron");
  const metrics = new Metrics(env.ANALYTICS);
  const start = Date.now();

  log.info("Triggered", { scheduledTime: new Date(event.scheduledTime).toISOString() });

  // Sweep paused workflows that have exceeded their timeout
  try {
    const engine = new WorkflowEngine(env, undefined, log.child({ task: "sweep" }), metrics);
    const list = await env.WORKFLOW_STATE.list({ prefix: "workflow:" });
    let expired = 0;

    for (const key of list.keys) {
      const raw = await env.WORKFLOW_STATE.get(key.name);
      if (!raw) continue;

      const state = JSON.parse(raw);
      if (
        (state.status === "paused_for_review" || state.status === "paused_at_step") &&
        state.timeoutAt &&
        new Date(state.timeoutAt).getTime() <= Date.now()
      ) {
        await engine.checkAndApplyTimeout(state);
        expired++;
      }
    }

    if (expired > 0) {
      log.info("Timed out paused workflows", { expired });
    }
  } catch (err) {
    log.error("Workflow sweep failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // Clean up orphaned Daytona sandboxes
  try {
    const daytona = new DaytonaClient(env, log.child({ task: "cleanup" }), metrics);
    const cleaned = await daytona.cleanup();
    if (cleaned > 0) {
      log.info("Cleaned up orphaned Daytona sandboxes", { cleaned });
    }
  } catch (err) {
    log.error("Daytona cleanup failed", { error: err instanceof Error ? err.message : String(err) });
  }

  metrics.write("cron", { status: "ok", durationMs: Date.now() - start });
}

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
