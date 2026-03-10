import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/types";

const TEST_API_KEY = "ctx_testapikey1234567890abcdef";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();

  // Seed a valid API key
  sessionStore.set(
    `apikey:${TEST_API_KEY}`,
    JSON.stringify({
      tenantId: "t1",
      userId: "u1",
      product: "bombastic",
      scopes: ["run", "sessions"],
      createdAt: new Date().toISOString(),
    }),
  );

  return {
    SESSION_CACHE: {
      put: vi.fn(async (key: string, value: string) => {
        sessionStore.set(key, value);
      }),
      get: vi.fn(async (key: string) => sessionStore.get(key) ?? null),
      delete: vi.fn(async (key: string) => {
        sessionStore.delete(key);
      }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    } as unknown as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue({ arrayBuffer: () => new ArrayBuffer(0) }),
    } as unknown as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
    COGNIUM_URL: "https://circle.cognium.net",
    DAYTONA_URL: "https://api.daytona.io",
    LLM_MODEL: "cognium/claude-sonnet-latest",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llmproxy.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_SECRET: "test-admin-secret",
  } as Env;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}`, ...extra };
}

/**
 * Parse SSE text into an array of { event, data } objects.
 */
function parseSSE(text: string): Array<{ event: string; data: string; id?: string }> {
  const events: Array<{ event: string; data: string; id?: string }> = [];
  const blocks = text.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    let id: string | undefined;

    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
      else if (line.startsWith("id: ")) id = line.slice(4);
    }

    if (event || data) {
      events.push({ event, data, id });
    }
  }

  return events;
}

describe("POST /v1/run/stream", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should reject invalid requests", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/run/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("should require auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/run/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("should emit conversation event with conversationId", async () => {
    // Mock LLM: single turn, direct response
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Hi!", tool_calls: undefined },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/run/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello", product: "bombastic" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSE(text);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("conversation");

    const convEvent = events.find((e) => e.event === "conversation");
    const convData = JSON.parse(convEvent!.data);
    expect(convData.conversationId).toMatch(/^conv_/);
    expect(convData.isNew).toBe(true);
    expect(convData.turnCount).toBe(0);

    // Done event should also include conversationId
    const doneEvent = events.find((e) => e.event === "done");
    const doneData = JSON.parse(doneEvent!.data);
    expect(doneData.conversationId).toBeDefined();
  });

  it("should return SSE content type and stream events", async () => {
    // Mock LLM: single turn, no tool calls (direct response)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "I'll help you with that.",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/run/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "help me",
          product: "bombastic",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const events = parseSSE(text);

    // Should have at least planning and done events
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("planning");
    expect(eventTypes).toContain("done");
  });

  it("should stream tool_call and tool_result events", async () => {
    const runicsSearchResult = {
      results: [{
        id: "s1", slug: "test-skill", version: "1.0.0", name: "Test",
        executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com",
        trustScore: 0.9, verificationTier: "verified", trustBadge: null,
        status: "published", skillType: "atomic", runCount: 5,
      }],
      confidence: "high", enriched: false,
      meta: { latencyMs: 40, tier: 1, cacheHit: false, llmInvoked: false },
    };

    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCallIndex++;
      // Call 1: LLM chat — calls findSkill
      if (fetchCallIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "chatcmpl-1", object: "chat.completion", created: Date.now(),
            model: "test-model",
            choices: [{
              index: 0,
              message: {
                role: "assistant", content: null,
                tool_calls: [{
                  id: "call-1", type: "function",
                  function: { name: "findSkill", arguments: JSON.stringify({ query: "test" }) },
                }],
              },
              finish_reason: "tool_calls",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        });
      }
      // Call 2: Runics search
      if (fetchCallIndex === 2) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSearchResult),
        });
      }
      // Call 3: LLM final response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: "chatcmpl-2", object: "chat.completion", created: Date.now(),
          model: "test-model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Found a skill for you.", tool_calls: undefined },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      });
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/run/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "test",
          product: "bombastic",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSSE(text);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("planning");
    expect(eventTypes).toContain("tool_call");
    expect(eventTypes).toContain("tool_result");
    expect(eventTypes).toContain("done");

    // Verify tool_call data contains findSkill
    const toolCallEvent = events.find((e) => e.event === "tool_call");
    const toolCallData = JSON.parse(toolCallEvent!.data);
    expect(toolCallData.name).toBe("findSkill");

    // Check incremental IDs
    const ids = events.map((e) => e.id).filter(Boolean).map(Number);
    expect(ids).toEqual(ids.sort((a, b) => a - b));
  });
});
