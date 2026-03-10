import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env, AppVariables } from "./types";
import { authMiddleware } from "./middleware/auth";
import runRoutes from "./routes/run";
import healthRoutes from "./routes/health";
import adminRoutes from "./routes/admin";
import sessionRoutes from "./routes/sessions";
import skillRoutes from "./routes/skills";
import { handleForgeMessage } from "./queues/forge-consumer";
import { handleCogniumMessage } from "./queues/cognium-consumer";

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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.route("/v1", runRoutes);
app.route("/v1/skills", skillRoutes);
app.route("/v1/sessions", sessionRoutes);
app.route("/admin", adminRoutes);
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
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
};
