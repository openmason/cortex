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
    getSessionByWorkflowId: vi.fn().mockResolvedValue(null),
  })),
}));

import app from "../../src/index";
import type { Env } from "../../src/types";

const TEST_API_KEY = "ctx_testapikey1234567890abcdef";
const TEST_ADMIN_SECRET = "test-admin-secret";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();

  // Seed a valid API key
  sessionStore.set(`apikey:${TEST_API_KEY}`, JSON.stringify({
    tenantId: "t1",
    userId: "u1",
    product: "bombastic",
    scopes: ["run", "sessions"],
    createdAt: new Date().toISOString(),
  }));

  return {
    SESSION_CACHE: {
      put: vi.fn(async (key: string, value: string) => { sessionStore.set(key, value); }),
      get: vi.fn(async (key: string) => sessionStore.get(key) ?? null),
      delete: vi.fn(async (key: string) => { sessionStore.delete(key); }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(async (key: string, value: string, opts?: any) => {
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
    ADMIN_SECRET: TEST_ADMIN_SECRET,
  } as Env;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}`, ...extra };
}

describe("API Routes", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  describe("GET /", () => {
    it("should return service info", async () => {
      const res = await app.fetch(
        new Request("http://localhost/"),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe("cortex");
      expect(body.version).toBe("0.1.0");
    });
  });

  describe("GET /health", () => {
    it("should return health check structure", async () => {
      // Mock Runics health check
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      const res = await app.fetch(
        new Request("http://localhost/health"),
        env,
        ctx,
      );

      // DB check will fail in test (no real Hyperdrive) → degraded
      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.status).toBe("degraded");
      expect(body.checks.kv).toBeDefined();
      expect(body.checks.kv.ok).toBe(true);
      expect(body.checks.db).toBeDefined();
      expect(body.checks.runics).toBeDefined();
      expect(body.checks.runics.ok).toBe(true);
      expect(body.version).toBe("0.1.0");
      expect(body.timestamp).toBeDefined();
    });

    it("should return degraded when Runics is down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

      const res = await app.fetch(
        new Request("http://localhost/health"),
        env,
        ctx,
      );

      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.status).toBe("degraded");
      expect(body.checks.runics.ok).toBe(false);
    });
  });

  describe("Auth middleware", () => {
    it("should return 401 when no auth header on /v1 routes", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/models"),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should return 401 for invalid API key", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/models", {
          headers: { Authorization: "Bearer invalid-key" },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should not require auth on public routes", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const res = await app.fetch(
        new Request("http://localhost/health"),
        env,
        ctx,
      );
      // Health returns 503 in tests (no Hyperdrive) but importantly NOT 401
      expect(res.status).not.toBe(401);
      const body = await res.json() as any;
      expect(body.checks).toBeDefined();
    });
  });

  describe("POST /v1/run", () => {
    it("should reject invalid requests", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("Invalid request");
    });

    it("should reject invalid conversationId format", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test",
            conversationId: "bad-format",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("Invalid request");
    });

    it("should accept valid conversationId format", async () => {
      // Mock LLM: direct response
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
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.conversationId).toBeDefined();
      expect(body.conversationId).toMatch(/^conv_/);
    });

    it("should reject invalid product names", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "test",
            product: "invalid_product",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should accept valid run requests", async () => {
      // Mock LiteLLM: LLM calls findSkill then buildPlan then responds
      const litellmChatResponse = (toolCalls?: any[], content?: string) => ({
        ok: true,
        json: () => Promise.resolve({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: Date.now(),
          model: "claude-sonnet-4-20250514",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: content ?? null,
              tool_calls: toolCalls ?? undefined,
            },
            finish_reason: toolCalls ? "tool_calls" : "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

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
        // Call 1: LiteLLM chat — LLM calls findSkill
        if (fetchCallIndex === 1) {
          return Promise.resolve(litellmChatResponse([{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: JSON.stringify({ query: "check my code" }) },
          }]));
        }
        // Call 2: Runics search (tool execution)
        if (fetchCallIndex === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchResult),
          });
        }
        // Call 3: LiteLLM chat — LLM calls buildPlan
        if (fetchCallIndex === 3) {
          return Promise.resolve(litellmChatResponse([{
            id: "call-2", type: "function",
            function: {
              name: "buildPlan",
              arguments: JSON.stringify({
                steps: [{ skillId: "s1", skillSlug: "test-skill" }],
                reasoning: "Found a matching skill",
              }),
            },
          }]));
        }
        // Call 4: LiteLLM chat — final response
        if (fetchCallIndex === 4) {
          return Promise.resolve(litellmChatResponse(undefined, "I'll check your code using test-skill."));
        }
        // Fallback
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "check my code",
            product: "controlcenter",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.workflowId).toBeDefined();
      // controlcenter defaults to review_before_run
      expect(body.status).toBe("paused_for_review");
    });
  });

  describe("GET /v1/run/:workflowId", () => {
    it("should return 404 for non-existent workflow", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run/nonexistent-id", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should return workflow state if it exists", async () => {
      // Seed KV with a workflow
      const state = {
        workflowId: "wf-123",
        status: "paused_for_review",
        tenantId: "t1",
      };
      await (env.WORKFLOW_STATE as any).put("workflow:wf-123", JSON.stringify(state));

      const res = await app.fetch(
        new Request("http://localhost/v1/run/wf-123", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.workflowId).toBe("wf-123");
      expect(body.status).toBe("paused_for_review");
    });
  });

  describe("POST /v1/run/:workflowId/resume", () => {
    it("should reject invalid resume requests", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run/wf-123/resume", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/models", () => {
    it("should return available models from the proxy", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [
            { id: "cognium/claude-sonnet-latest", object: "model", owned_by: "anthropic" },
            { id: "cognium/deepseek-latest", object: "model", owned_by: "deepseek" },
          ],
        }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/models", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.models).toHaveLength(2);
      expect(body.models[0].id).toBe("cognium/claude-sonnet-latest");
      expect(body.default).toBe("cognium/claude-sonnet-latest");
      expect(body.aliases).toBeDefined();
      expect(body.aliases.CLAUDE_SONNET).toBe("cognium/claude-sonnet-latest");
    });

    it("should return 502 when proxy is down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

      const res = await app.fetch(
        new Request("http://localhost/v1/models", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(502);
    });
  });

  describe("POST /v1/run/:workflowId/save", () => {
    it("should reject save with missing fields", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/run/wf-123/save", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });
  });
});
