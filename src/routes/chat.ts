import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { z } from "zod";
import type { Env, AppVariables, RunRequest, StreamPart } from "../types";
import { SupervisorAgent } from "../agents/supervisor";
import { requireScope } from "../middleware/auth";
import { Logger } from "../observability/logger";
import { Metrics } from "../observability/metrics";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// Scope enforcement
app.use("/chat", requireScope("run"));

// ---------------------------------------------------------------------------
// POST /v1/chat — Clove-compatible chat endpoint (AI SDK Data Stream)
// ---------------------------------------------------------------------------
// Support both AI SDK parts format and simple content format
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  // AI SDK format: parts array
  parts: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ).optional(),
  // Simple format: content string
  content: z.string().optional(),
}).refine(
  (m) => m.parts !== undefined || m.content !== undefined,
  { message: "Message must have either 'parts' or 'content'" },
);

const chatSchema = z.object({
  productId: z.enum(["bombastic", "costaff", "controlcenter"]),
  userId: z.string().min(1).optional(),
  messages: z.array(messageSchema).min(1),
  conversationId: z.string().min(1).max(200).optional(),
  context: z.record(z.unknown()).optional(),
  model: z.string().max(100).optional(),
});

app.post("/chat", async (c) => {
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  // Extract prompt text from the last user message
  const userMessages = parsed.data.messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    return c.json({ error: "No user message found" }, 400);
  }

  // Support both formats: parts array (AI SDK) or content string (simple)
  let prompt: string;
  if (lastUserMessage.parts) {
    prompt = lastUserMessage.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n");
  } else {
    prompt = lastUserMessage.content ?? "";
  }

  if (!prompt) {
    return c.json({ error: "No text content in user message" }, 400);
  }

  // Build RunRequest from chat format
  const request: RunRequest = {
    prompt,
    tenantId: c.get("tenantId"),
    userId: parsed.data.userId ?? c.get("userId"),
    product: parsed.data.productId,
    conversationId: parsed.data.conversationId,
    context: parsed.data.context,
    model: parsed.data.model,
  };

  // Always stream
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

export default app;
