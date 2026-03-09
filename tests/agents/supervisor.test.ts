import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupervisorAgent } from "../../src/agents/supervisor";
import type { Env, RunRequest } from "../../src/types";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  return {
    SESSION_CACHE: {} as KVNamespace,
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
});
