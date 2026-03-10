import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupervisorAgent } from "../../src/agents/supervisor";
import type { Env, RunRequest } from "../../src/types";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  return {
    SESSION_CACHE: {
      put: vi.fn(async (key: string, value: string) => { sessionStore.set(key, value); }),
      get: vi.fn(async (key: string) => sessionStore.get(key) ?? null),
      delete: vi.fn(async (key: string) => { sessionStore.delete(key); }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
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
    LLM_MODEL: "claude-sonnet-4-20250514",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://litellm.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_SECRET: "test-secret",
  } as Env;
}

describe("SupervisorAgent", () => {
  let supervisor: SupervisorAgent;
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    supervisor = new SupervisorAgent(env);
  });

  describe("handleRequest", () => {
    it("should return no_match when Runics finds nothing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          confidence: "no_match",
          enriched: false,
          meta: { latencyMs: 50, tier: 3, cacheHit: false, llmInvoked: true },
        }),
      }));

      const request: RunRequest = {
        prompt: "do something impossible",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      };

      const response = await supervisor.handleRequestDirect(request, ctx);

      expect(response.status).toBe("failed");
      expect(response.summary).toContain("No matching skills");
    });

    it("should create a plan and pause for controlcenter (review_before_run)", async () => {
      // First fetch: Runics search
      // Subsequent fetches: MCP calls / Runics invocations
      let fetchCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          // Runics search response
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              results: [
                {
                  id: "skill-1",
                  slug: "cargo-audit",
                  version: "1.0.0",
                  name: "Cargo Audit",
                  executionLayer: "container",
                  trustScore: 0.89,
                  verificationTier: "verified",
                  trustBadge: "upstream",
                  status: "published",
                  skillType: "atomic",
                  runCount: 47,
                },
              ],
              confidence: "high",
              enriched: false,
              meta: { latencyMs: 48, tier: 1, cacheHit: false, llmInvoked: false },
            }),
          });
        }
        // MCP / invocation calls
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const request: RunRequest = {
        prompt: "check rust dependencies for vulnerabilities",
        tenantId: "t1",
        userId: "u1",
        product: "controlcenter",
      };

      const response = await supervisor.handleRequestDirect(request, ctx);

      expect(response.status).toBe("paused_for_review");
      expect(response.plan).toBeDefined();
      expect(response.plan!.steps.length).toBe(1);
      expect(response.plan!.steps[0].skill.slug).toBe("cargo-audit");
      expect(response.summary).toContain("review");
    });

    it("should execute immediately for bombastic (full_auto)", async () => {
      let fetchCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              results: [
                {
                  id: "skill-1",
                  slug: "cargo-clippy",
                  version: "1.0.0",
                  name: "Cargo Clippy",
                  executionLayer: "mcp-remote",
                  mcpUrl: "https://mcp.example.com",
                  trustScore: 0.91,
                  verificationTier: "verified",
                  trustBadge: "upstream",
                  status: "published",
                  skillType: "atomic",
                  runCount: 100,
                },
              ],
              confidence: "high",
              enriched: false,
              meta: { latencyMs: 30, tier: 1, cacheHit: true, llmInvoked: false },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { output: "no warnings" } }),
        });
      }));

      const request: RunRequest = {
        prompt: "lint my rust code",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      };

      const response = await supervisor.handleRequestDirect(request, ctx);

      expect(response.status).toBe("completed");
      expect(response.result).toBeDefined();
    });
  });

  describe("handleResume", () => {
    it("should return failed for non-existent workflow", async () => {
      const response = await supervisor.handleResume("nonexistent", true, undefined, ctx);
      expect(response.status).toBe("failed");
      expect(response.summary).toContain("not found");
    });
  });

  describe("handleRequest (conversation)", () => {
    it("should return a conversationId on new requests", async () => {
      // Mock LLM: single turn, direct response (no tool calls)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Hello!", tool_calls: undefined },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      }));

      const request: RunRequest = {
        prompt: "hello",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      };

      const response = await supervisor.handleRequest(request, ctx);

      expect(response.conversationId).toBeDefined();
      expect(response.conversationId).toMatch(/^conv_/);
    });

    it("should return failed for non-existent conversationId", async () => {
      const request: RunRequest = {
        prompt: "continue",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        conversationId: "conv_00000000-0000-0000-0000-000000000000",
      };

      const response = await supervisor.handleRequest(request, ctx);

      expect(response.status).toBe("failed");
      expect(response.summary).toContain("not found");
      expect(response.conversationId).toBe("conv_00000000-0000-0000-0000-000000000000");
    });

    it("should persist and reload conversation history", async () => {
      let callIndex = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callIndex++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: `chatcmpl-${callIndex}`,
            object: "chat.completion",
            created: Date.now(),
            model: "test-model",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: callIndex <= 1 ? "Answer to turn 1." : "Answer to turn 2, with context from turn 1.",
                tool_calls: undefined,
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        });
      }));

      // Turn 1
      const req1: RunRequest = {
        prompt: "What is Cortex?",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      };

      const res1 = await supervisor.handleRequest(req1, ctx);
      expect(res1.conversationId).toBeDefined();

      // Wait for waitUntil to complete (it's a mock, should resolve sync)
      const convId = res1.conversationId!;

      // Turn 2 — same conversation
      const req2: RunRequest = {
        prompt: "Tell me more",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        conversationId: convId,
      };

      const res2 = await supervisor.handleRequest(req2, ctx);
      expect(res2.conversationId).toBe(convId);
      expect(res2.status).not.toBe("failed");

      // Verify the LLM received history messages (the second fetch should have more messages)
      const fetchCalls = (fetch as any).mock.calls;
      // The second LLM call should have the URL and body with history
      const secondCallBody = JSON.parse(fetchCalls[1][1].body);
      const messageRoles = secondCallBody.messages.map((m: any) => m.role);
      // Should have: system, user (turn 1), assistant (turn 1 answer), user (turn 2)
      expect(messageRoles).toContain("system");
      expect(messageRoles.filter((r: string) => r === "user").length).toBeGreaterThanOrEqual(2);
      expect(messageRoles.filter((r: string) => r === "assistant").length).toBeGreaterThanOrEqual(1);
    });
  });
});
