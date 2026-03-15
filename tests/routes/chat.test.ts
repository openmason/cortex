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
// SSE streaming helpers — build mock streaming responses for chatStream()
// ---------------------------------------------------------------------------

function makeChunkSSE(
  content?: string | null,
  toolCalls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>,
  finishReason?: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number },
): string {
  const chunk = {
    id: "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [{
      index: 0,
      delta: {
        ...(content !== undefined ? { content } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason ?? null,
    }],
    ...(usage ? { usage } : {}),
  };
  return `data: ${JSON.stringify(chunk)}`;
}

function makeSSEBody(...sseLines: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of sseLines) {
        controller.enqueue(encoder.encode(line + "\n\n"));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function mockStreamResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    ok: true,
    body: makeSSEBody(
      makeChunkSSE(content),
      makeChunkSSE(null, undefined, "stop", usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ),
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
      scopes: ["run", "sessions"],
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

describe("POST /v1/chat", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should reject invalid requests (missing messages)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ productId: "bombastic" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("should reject invalid productId", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "invalid-product",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("should require auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("should reject when no user message found", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "assistant", parts: [{ type: "text", text: "I can help" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No user message found");
  });

  it("should reject when no text content in user message", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "image", text: undefined }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No text content in user message");
  });

  it("should return SSE content type with AI SDK header", async () => {
    // Mock LLM: single turn, streaming response
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockStreamResponse("Hello! How can I help?"),
    ));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
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

    expect(types).toContain("text-start");
    expect(types).toContain("finish");
    expect(text).toContain(": [DONE]");
  });

  it("should emit conversation data part with conversationId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockStreamResponse("Hi!"),
    ));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);

    const dataPart = parts.find((p) => p.type === "data") as any;
    expect(dataPart).toBeDefined();
    expect(dataPart.data).toBeDefined();
    const convData = dataPart.data.find((d: any) => d.type === "conversation");
    expect(convData).toBeDefined();
    expect(convData.conversationId).toMatch(/^conv_/);
    expect(convData.isNew).toBe(true);
  });

  it("should extract text from multiple parts", async () => {
    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: any) => {
      if (opts?.body) {
        try { capturedBody = JSON.parse(opts.body); } catch { /* ignore */ }
      }
      return Promise.resolve(mockStreamResponse("Done."));
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            {
              role: "user",
              parts: [
                { type: "text", text: "first line" },
                { type: "image" },
                { type: "text", text: "second line" },
              ],
            },
          ],
        }),
      }),
      env,
      ctx,
    );

    // Consume the stream to ensure all fetch calls complete
    await res.text();

    // The LLM should receive the combined prompt text
    expect(capturedBody).toBeDefined();
    const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("first line");
    expect(userMsg.content).toContain("second line");
  });

  it("should use last user message for prompt extraction", async () => {
    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: any) => {
      if (opts?.body) {
        try { capturedBody = JSON.parse(opts.body); } catch { /* ignore */ }
      }
      return Promise.resolve(mockStreamResponse("Response."));
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "text", text: "first question" }] },
            { role: "assistant", parts: [{ type: "text", text: "first answer" }] },
            { role: "user", parts: [{ type: "text", text: "follow up question" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    // Consume the stream to ensure all fetch calls complete
    await res.text();

    // The prompt sent to LLM should be the last user message
    expect(capturedBody).toBeDefined();
    const userMsg = capturedBody.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("follow up question");
  });

  it("should pass conversationId from request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockStreamResponse("Hi!"),
    ));

    const convId = "conv_00000000-0000-0000-0000-000000000001";

    // Seed the conversation in KV so load() finds it
    const convKey = `conversation:t1:${convId}`;
    await env.SESSION_CACHE.put(convKey, JSON.stringify({
      conversationId: convId,
      tenantId: "t1",
      userId: "u1",
      product: "bombastic",
      turns: [],
      turnCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          conversationId: convId,
          messages: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);

    const dataPart = parts.find((p) => p.type === "data") as any;
    expect(dataPart).toBeDefined();
    const convData = dataPart.data.find((d: any) => d.type === "conversation");
    expect(convData.conversationId).toBe(convId);
    expect(convData.isNew).toBe(false);
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

      // Call 1: LLM streaming — calls findSkill
      if (fetchCallIndex === 1 && isLLMCall) {
        return Promise.resolve({
          ok: true,
          body: makeSSEBody(
            makeChunkSSE(undefined, [{
              index: 0, id: "call-1", type: "function",
              function: { name: "findSkill", arguments: JSON.stringify({ query: "test" }) },
            }]),
            makeChunkSSE(null, undefined, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
          ),
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
      // Call 3: LLM streaming — final response
      return Promise.resolve({
        ok: true,
        body: makeSSEBody(
          makeChunkSSE("Found a skill for you."),
          makeChunkSSE(null, undefined, "stop", { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }),
        ),
        headers: { get: () => null },
      });
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "text", text: "find a test skill" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);
    const types = parts.map((p) => p.type);

    expect(types).toContain("text-start");
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("finish");

    const toolCallPart = parts.find((p) => p.type === "tool-call") as any;
    expect(toolCallPart.toolName).toBe("findSkill");
    expect(toolCallPart.toolCallId).toBeDefined();
  });

  it("should accept free-form conversationId for per-todo scoping", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      mockStreamResponse("Got it!"),
    ));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          conversationId: "todo:abc123",
          messages: [
            { role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    // Free-form conversationId should not be rejected (no UUID regex)
    expect(res.status).toBe(200);
    const text = await res.text();
    const parts = parseStreamParts(text);
    const types = parts.map((p) => p.type);
    expect(types).toContain("finish");
  });

  it("should accept context object and pass it through", async () => {
    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: any) => {
      if (opts?.body) {
        try { capturedBody = JSON.parse(opts.body); } catch { /* ignore */ }
      }
      return Promise.resolve(mockStreamResponse("I see your context."));
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          messages: [
            { role: "user", parts: [{ type: "text", text: "plan my day" }] },
          ],
          context: {
            todoList: [{ title: "Buy groceries", status: "pending" }],
            userMemory: { name: "Sara", relation: "sister" },
          },
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    await res.text();

    // Context should be merged into the system prompt, not as a separate user message
    expect(capturedBody).toBeDefined();
    const systemMsg = capturedBody.messages.find((m: any) => m.role === "system");
    expect(systemMsg.content).toContain("Context");
    expect(systemMsg.content).toContain("Buy groceries");
    expect(systemMsg.content).toContain("Sara");
  });

  it("should accept model field for per-request model selection", async () => {
    let capturedBody: any;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: any) => {
      if (opts?.body) {
        try { capturedBody = JSON.parse(opts.body); } catch { /* ignore */ }
      }
      return Promise.resolve(mockStreamResponse("Using haiku."));
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "bombastic",
          model: "claude-haiku",
          messages: [
            { role: "user", parts: [{ type: "text", text: "quick question" }] },
          ],
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    await res.text();

    // Model alias should be resolved to proxy model ID
    expect(capturedBody).toBeDefined();
    expect(capturedBody.model).toBe("cognium/claude-haiku-latest");
  });
});
