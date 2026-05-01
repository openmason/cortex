import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WorkflowRepository to avoid real DB calls in auth middleware
vi.mock("../../src/db/repository", () => ({
  WorkflowRepository: vi.fn().mockImplementation(() => ({
    getApiKey: vi.fn().mockResolvedValue(null),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    loadPolicy: vi.fn().mockResolvedValue(null),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    recordStepExecution: vi.fn(),
    writeTrace: vi.fn(),
    markTraceAsSaved: vi.fn(),
  })),
}));

import app from "../../src/index";
import type { Env } from "../../src/types";

// ---------------------------------------------------------------------------
// Mock response helpers — non-streaming JSON (agentLoopStreaming uses chat())
// ---------------------------------------------------------------------------

function makeChatResponse(
  content: string | null,
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  finishReason = "stop",
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content, tool_calls: toolCalls },
      finish_reason: finishReason,
    }],
    usage,
  };
}

function mockChatResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    ok: true,
    json: () => Promise.resolve(makeChatResponse(content, undefined, "stop", usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })),
    headers: { get: () => null },
  };
}

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
      scopes: ["workflows", "sessions"],
      createdAt: new Date().toISOString(),
    }),
  );

  // Seed model capabilities cache so getToolCallModel() doesn't call /v1/models
  sessionStore.set("models:capabilities", JSON.stringify([
    { id: "cognium/claude-sonnet-latest", object: "model", supports_tool_calls: true },
  ]));

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
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
    DAYTONA_TARGET: "us",
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
 * Parse AI SDK Data Stream format into an array of StreamPart objects.
 * Each line is `data: {json}` — no `event:` field.
 */
function parseStreamParts(text: string): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const json = line.slice(6);
      try {
        parts.push(JSON.parse(json));
      } catch {
        // skip unparseable lines
      }
    }
  }

  return parts;
}

describe("POST /v1/workflows/stream", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should reject invalid requests", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/stream", {
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
      new Request("http://localhost/v1/workflows/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("should emit conversation data part with conversationId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockChatResponse("Hi!")));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello", product: "bombastic" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);
    const types = parts.map((p) => p.type);

    // Should have a "data" part containing conversation info
    expect(types).toContain("data");

    const dataPart = parts.find((p) => p.type === "data") as any;
    expect(dataPart.data).toBeDefined();
    const convData = dataPart.data.find((d: any) => d.type === "conversation");
    expect(convData).toBeDefined();
    expect(convData.conversationId).toMatch(/^conv_/);
    expect(convData.isNew).toBe(true);

    // Should have a "finish" part
    expect(types).toContain("finish");
  });

  it("should return SSE content type with AI SDK header and stream events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockChatResponse("I'll help you with that.")));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/stream", {
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
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const text = await res.text();
    const parts = parseStreamParts(text);
    const types = parts.map((p) => p.type);

    // Should have text-start and finish events
    expect(types).toContain("text-start");
    expect(types).toContain("finish");

    // Stream should end with : [DONE] comment
    expect(text).toContain(": [DONE]");
  });

  it("should stream tool-call and tool-result events", async () => {
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
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      fetchCallIndex++;

      const isLLMCall = typeof url === "string" && url.includes("/v1/chat/completions");

      // Call 1: LLM — calls findSkill tool
      if (fetchCallIndex === 1 && isLLMCall) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeChatResponse(null, [{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: JSON.stringify({ query: "test" }) },
          }], "tool_calls")),
          headers: { get: () => null },
        });
      }
      // Call 2: Runics search (non-streaming JSON)
      if (fetchCallIndex === 2 && !isLLMCall) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSearchResult),
        });
      }
      // Call 3: LLM — final text response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeChatResponse("Found a skill for you.")),
        headers: { get: () => null },
      });
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/stream", {
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
    const parts = parseStreamParts(text);
    const types = parts.map((p) => p.type);

    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("finish");

    // Verify tool-call data contains findSkill
    const toolCallPart = parts.find((p) => p.type === "tool-call") as any;
    expect(toolCallPart.toolName).toBe("findSkill");
    expect(toolCallPart.toolCallId).toBeDefined();
  });

  it("should emit text-start, text-delta, and text-end events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockChatResponse("I can help you.")));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "help me", product: "bombastic" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);

    const textStart = parts.find((p) => p.type === "text-start") as any;
    const textDeltas = parts.filter((p) => p.type === "text-delta");
    const textEnd = parts.find((p) => p.type === "text-end") as any;

    expect(textStart).toBeDefined();
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    expect(textDeltas.map((d: any) => d.delta).join("")).toBe("I can help you.");
    expect(textEnd).toBeDefined();
    expect(textStart.id).toBe(textEnd.id);
  });
});
