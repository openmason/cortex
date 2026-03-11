import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env, AppVariables } from "./types";
import { authMiddleware, rateLimitMiddleware } from "./middleware/auth";
import runRoutes from "./routes/run";
import healthRoutes from "./routes/health";
import adminRoutes from "./routes/admin";
import sessionRoutes from "./routes/sessions";
import skillRoutes from "./routes/skills";
import demoRoutes from "./routes/demo";
import { handleForgeMessage } from "./queues/forge-consumer";
import { handleCogniumMessage } from "./queues/cognium-consumer";
import { WorkflowEngine } from "./workflow/engine";
import { DaytonaClient } from "./clients/daytona";

// Re-export the Durable Object class (required by wrangler)
export { WorkflowDurableObject } from "./workflow/durable-object";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.onError((err, c) => {
  console.error("[cortex] Unhandled error:", err);
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
app.use("/v1/*", authMiddleware);
app.use("/v1/run", rateLimitMiddleware);
app.use("/v1/run/*", rateLimitMiddleware);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.route("/v1", runRoutes);
app.route("/v1/skills", skillRoutes);
app.route("/v1/sessions", sessionRoutes);
app.route("/admin", adminRoutes);
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
// Queue Consumers
// ---------------------------------------------------------------------------
async function handleQueue(
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      switch (batch.queue) {
        case "cortex-forge":
          await handleForgeMessage(msg.body as any, env);
          msg.ack();
          break;

        case "cortex-cognium":
          await handleCogniumMessage(msg.body as any, env);
          msg.ack();
          break;

        default:
          console.warn(`[queue] Unknown queue: ${batch.queue}`);
          msg.ack();
      }
    } catch (err) {
      console.error(`[queue] Error processing message on ${batch.queue}:`, err);
      msg.retry();
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled (Cron) Handler
// ---------------------------------------------------------------------------
async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  console.log(`[cron] Triggered at ${new Date(event.scheduledTime).toISOString()}`);

  // Sweep paused workflows that have exceeded their timeout
  try {
    const engine = new WorkflowEngine(env);
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
      console.log(`[cron] Timed out ${expired} paused workflow(s)`);
    }
  } catch (err) {
    console.error("[cron] Workflow sweep failed:", err);
  }

  // Clean up orphaned Daytona sandboxes
  try {
    const daytona = new DaytonaClient(env);
    const cleaned = await daytona.cleanup();
    if (cleaned > 0) {
      console.log(`[cron] Cleaned up ${cleaned} orphaned Daytona sandbox(es)`);
    }
  } catch (err) {
    console.error("[cron] Daytona cleanup failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
};
