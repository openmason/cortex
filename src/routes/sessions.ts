import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { WorkflowRepository } from "../db/repository";
import { ConversationManager, type ConversationState } from "../conversation/manager";
import { requireScope } from "../middleware/auth";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", requireScope("sessions"));

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

// ---------------------------------------------------------------------------
// GET /v1/sessions/conversations — List conversations for the tenant
// ---------------------------------------------------------------------------
app.get("/conversations", async (c) => {
  const tenantId = c.get("tenantId");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);

  // KV list with prefix to find all conversations for this tenant
  const prefix = `conversation:${tenantId}:`;
  const listResult = await c.env.SESSION_CACHE.list({ prefix, limit });

  const conversations: Array<{
    conversationId: string;
    product: string;
    turnCount: number;
    createdAt: string;
    lastActivityAt: string;
  }> = [];

  for (const key of listResult.keys) {
    const raw = await c.env.SESSION_CACHE.get(key.name);
    if (!raw) continue;

    try {
      const state: ConversationState = JSON.parse(raw);
      conversations.push({
        conversationId: state.conversationId,
        product: state.product,
        turnCount: state.turnCount,
        createdAt: state.createdAt,
        lastActivityAt: state.lastActivityAt,
      });
    } catch {
      // Skip corrupted entries
    }
  }

  // Sort by most recent activity
  conversations.sort((a, b) =>
    new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );

  return c.json({ conversations, count: conversations.length });
});

// ---------------------------------------------------------------------------
// GET /v1/sessions/conversations/:id — Get conversation detail with messages
// ---------------------------------------------------------------------------
app.get("/conversations/:id", async (c) => {
  const conversationId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const manager = new ConversationManager(c.env);
  const state = await manager.load(tenantId, conversationId);

  if (!state) {
    return c.json({ error: "Conversation not found or expired" }, 404);
  }

  // Compute aggregate usage from turn metrics
  const turnMetrics = state.turnMetrics ?? [];
  const totalTokens = turnMetrics.reduce((sum, t) => sum + (t.tokens ?? 0), 0);
  const totalCost = turnMetrics.reduce((sum, t) => sum + (t.cost ?? 0), 0);

  return c.json({
    conversationId: state.conversationId,
    product: state.product,
    userId: state.userId,
    turnCount: state.turnCount,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
    messages: state.messages,
    turnMetrics,
    usage: { totalTokens, totalCost },
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/sessions/conversations/:id — Delete a conversation
// ---------------------------------------------------------------------------
app.delete("/conversations/:id", async (c) => {
  const conversationId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const key = `conversation:${tenantId}:${conversationId}`;
  await c.env.SESSION_CACHE.delete(key);

  return c.json({ deleted: true });
});

export default app;
