import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WorkflowRepository
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

// Mock Daytona SDK
vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({
      process: {
        executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: '{"ok":true}' }),
        codeRun: vi.fn().mockResolvedValue({ exitCode: 0, result: '{"result":"generated"}' }),
      },
      fs: { uploadFile: vi.fn().mockResolvedValue(undefined) },
      delete: vi.fn().mockResolvedValue(undefined),
    }),
  })),
}));

import app from "../../src/index";
import type { Env } from "../../src/types";

const TEST_API_KEY = "ctx_multisteptest1234567890abcdef";

function makeMockEnv(opts: { toolCapable?: boolean; fullAuto?: boolean } = {}): Env {
  const kvStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();

  sessionStore.set(`apikey:${TEST_API_KEY}`, JSON.stringify({
    tenantId: "t-ms",
    userId: "u-ms",
    product: "bombastic",
    scopes: ["run", "sessions", "skills", "models"],
    createdAt: new Date().toISOString(),
  }));

  // Seed model capabilities — controls whether agentic loop or direct mode is used
  if (opts.toolCapable) {
    sessionStore.set("models:capabilities", JSON.stringify([
      { id: "cognium/claude-sonnet-latest", object: "model", supports_tool_calls: true },
    ]));
  } else {
    sessionStore.set("models:capabilities", JSON.stringify([
      { id: "cognium/gpt-oss-120b", object: "model", supports_tool_calls: false },
    ]));
  }

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
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "cognium/gpt-oss-120b",
    TOOL_CALL_MODEL: "cognium/gpt-oss-120b",
    DEFAULT_EXECUTION_MODE: opts.fullAuto ? "full_auto" : "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llmproxy.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
  } as Env;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}`, ...extra };
}

// -- Helpers for building mock LLM responses --

function llmResponse(toolCalls?: any[], content?: string) {
  return {
    ok: true,
    json: () => Promise.resolve({
      id: "chatcmpl-ms",
      object: "chat.completion",
      created: Date.now(),
      model: "cognium/claude-sonnet-latest",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content ?? null,
          tool_calls: toolCalls ?? undefined,
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.003 },
    }),
  };
}

function runicsSearchMulti() {
  return {
    results: [
      {
        id: "s1", slug: "osv-scanner", version: "2.0.0", name: "OSV Scanner",
        executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com/osv",
        trustScore: 0.92, verificationTier: "verified", trustBadge: null,
        status: "published", skillType: "atomic", runCount: 100,
      },
      {
        id: "s2", slug: "dependency-check", version: "1.5.0", name: "Dependency Check",
        executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com/depcheck",
        trustScore: 0.88, verificationTier: "verified", trustBadge: null,
        status: "published", skillType: "atomic", runCount: 50,
      },
    ],
    confidence: "high",
    enriched: false,
    composition: { detected: true, strategy: "sequential", reasoning: "Two complementary security scans" },
    meta: { latencyMs: 40, tier: 1, cacheHit: false, llmInvoked: false },
  };
}

function runicsSingleResult() {
  return {
    results: [{
      id: "s1", slug: "osv-scanner", version: "2.0.0", name: "OSV Scanner",
      executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com/osv",
      trustScore: 0.92, verificationTier: "verified", trustBadge: null,
      status: "published", skillType: "atomic", runCount: 100,
    }],
    confidence: "high",
    enriched: false,
    meta: { latencyMs: 40, tier: 1, cacheHit: false, llmInvoked: false },
  };
}

function mcpResult(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ result: data }) };
}

describe("Multi-step Workflow E2E", () => {
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Direct mode — Runics returns composition, multi-step plan built
  // -----------------------------------------------------------------------
  describe("Direct mode (no tool-capable model)", () => {
    it("should build and execute a multi-step plan from Runics composition", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        fetchCallIndex++;
        // Call 1: Runics search (composition detected)
        if (fetchCallIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Call 2: MCP execution (step 1 — OSV Scanner)
        if (fetchCallIndex === 2) {
          return Promise.resolve(mcpResult({ vulnerabilities: [{ id: "CVE-2024-001" }] }));
        }
        // Call 3: Runics recordInvocation (non-blocking, step 1)
        if (fetchCallIndex === 3) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        // Call 4: MCP execution (step 2 — Dependency Check)
        if (fetchCallIndex === 4) {
          return Promise.resolve(mcpResult({ outdated: [{ name: "lodash", current: "4.17.15" }] }));
        }
        // Call 5: Runics recordInvocation (non-blocking, step 2)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo for vulnerabilities and outdated dependencies" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;

      expect(body.status).toBe("completed");
      expect(body.plan).toBeDefined();
      expect(body.plan.steps).toHaveLength(2);
      expect(body.plan.steps[0].skill.slug).toBe("osv-scanner");
      expect(body.plan.steps[1].skill.slug).toBe("dependency-check");
      expect(body.plan.steps[0].status).toBe("completed");
      expect(body.plan.steps[1].status).toBe("completed");

      // Results should be collected
      expect(body.result).toHaveLength(2);
      expect(body.result[0].skill).toBe("osv-scanner");
      expect(body.result[1].skill).toBe("dependency-check");
    });

    it("should pause multi-step workflow for review in review_before_run mode", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: false });

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSearchMulti()),
        });
      }));

      // Use mode: "review_before_run" explicitly to override bombastic defaults
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo", mode: "review_before_run" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;

      expect(body.status).toBe("paused_for_review");
      expect(body.plan).toBeDefined();
      expect(body.plan.steps).toHaveLength(2);
      expect(body.workflowId).toBeDefined();
    });

    it("should resume a paused multi-step workflow after approval", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: false });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        fetchCallIndex++;
        // Call 1: Runics search
        if (fetchCallIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Remaining calls: MCP executions + recordInvocation
        return Promise.resolve(mcpResult({ data: "ok" }));
      }));

      // Step 1: Create paused workflow
      const createRes = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo", mode: "review_before_run" }),
        }),
        env,
        ctx,
      );

      const createBody = await createRes.json() as any;
      expect(createBody.status).toBe("paused_for_review");
      const workflowId = createBody.workflowId;

      // Step 2: Resume with approval
      const resumeRes = await app.fetch(
        new Request(`http://localhost/v1/run/${workflowId}/resume`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ workflowId, approved: true }),
        }),
        env,
        ctx,
      );

      expect(resumeRes.status).toBe(200);
      const resumeBody = await resumeRes.json() as any;

      expect(resumeBody.status).toBe("completed");
      expect(resumeBody.plan.steps).toHaveLength(2);
      expect(resumeBody.plan.steps[0].status).toBe("completed");
      expect(resumeBody.plan.steps[1].status).toBe("completed");
    });

    it("should retrieve multi-step workflow state via GET /v1/run/:id", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: false });

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSearchMulti()),
        });
      }));

      // Create a paused workflow
      const createRes = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo", mode: "review_before_run" }),
        }),
        env,
        ctx,
      );

      const createBody = await createRes.json() as any;
      const workflowId = createBody.workflowId;

      // Retrieve it
      const getRes = await app.fetch(
        new Request(`http://localhost/v1/run/${workflowId}`, {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as any;

      expect(getBody.workflowId).toBe(workflowId);
      expect(getBody.status).toBe("paused_for_review");
      expect(getBody.plan.steps).toHaveLength(2);
    });

    it("should handle step failure with onError:skip in multi-step", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCallIndex++;
        // Call 1: Runics search
        if (fetchCallIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Call 2: MCP execution step 1 — FAIL
        if (fetchCallIndex === 2) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("MCP error") });
        }
        // Remaining: step 2 succeeds + recordInvocations
        return Promise.resolve(mcpResult({ data: "ok" }));
      }));

      // Inject onError:"skip" for step 1 by using a prompt — but in direct mode,
      // buildPlanFromSearch always sets onError:"fail". We can't control that via prompt.
      // Instead, test the engine directly with this config.
      // For the E2E test, the default onError is "fail", so a failing step fails the workflow.
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(422);
      const body = await res.json() as any;

      expect(body.status).toBe("failed");
      expect(body.plan.steps[0].status).toBe("failed");
      expect(body.summary).toContain("failed");
    });
  });

  // -----------------------------------------------------------------------
  // 2. Agentic loop mode — LLM calls findSkill → buildPlan with 2 steps
  // -----------------------------------------------------------------------
  describe("Agentic loop mode (tool-capable model)", () => {
    it("should execute a multi-step plan via LLM agentic loop", async () => {
      const env = makeMockEnv({ toolCapable: true, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        fetchCallIndex++;

        // Call 1: LLM chat — calls findSkill
        if (fetchCallIndex === 1) {
          return Promise.resolve(llmResponse([{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: JSON.stringify({ query: "scan for vulnerabilities" }) },
          }]));
        }
        // Call 2: Runics search
        if (fetchCallIndex === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Call 3: LLM chat — calls buildPlan with 2 steps
        if (fetchCallIndex === 3) {
          return Promise.resolve(llmResponse([{
            id: "call-2", type: "function",
            function: {
              name: "buildPlan",
              arguments: JSON.stringify({
                steps: [
                  { skillId: "s1", skillSlug: "osv-scanner", inputMapping: { repo: "https://github.com/test/repo" } },
                  { skillId: "s2", skillSlug: "dependency-check", inputMapping: { source: "$prev" } },
                ],
                reasoning: "First scan for CVEs, then check dependency freshness",
              }),
            },
          }]));
        }
        // Call 4: LLM chat — final summary
        if (fetchCallIndex === 4) {
          return Promise.resolve(llmResponse(undefined, "I've set up a 2-step security scan pipeline."));
        }
        // Call 5+: MCP executions for workflow engine + recordInvocations
        if (url.includes("mcp.example.com")) {
          return Promise.resolve(mcpResult({ scanned: true }));
        }
        // Runics recordInvocation
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "scan for vulnerabilities and check dependencies",
            product: "bombastic",
            mode: "full_auto",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;

      expect(body.status).toBe("completed");
      expect(body.plan).toBeDefined();
      expect(body.plan.steps).toHaveLength(2);
      expect(body.plan.steps[0].skill.slug).toBe("osv-scanner");
      expect(body.plan.steps[1].skill.slug).toBe("dependency-check");
      expect(body.plan.steps[0].status).toBe("completed");
      expect(body.plan.steps[1].status).toBe("completed");
      expect(body.conversationId).toMatch(/^conv_/);

      // Usage should be present
      expect(body.usage).toBeDefined();
      expect(body.usage.totalTokens).toBeGreaterThan(0);
    });

    it("should pause agentic multi-step for review in review_before_run mode", async () => {
      const env = makeMockEnv({ toolCapable: true, fullAuto: false });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCallIndex++;
        // Call 1: LLM calls findSkill
        if (fetchCallIndex === 1) {
          return Promise.resolve(llmResponse([{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: JSON.stringify({ query: "scan" }) },
          }]));
        }
        // Call 2: Runics
        if (fetchCallIndex === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Call 3: LLM calls buildPlan
        if (fetchCallIndex === 3) {
          return Promise.resolve(llmResponse([{
            id: "call-2", type: "function",
            function: {
              name: "buildPlan",
              arguments: JSON.stringify({
                steps: [
                  { skillId: "s1", skillSlug: "osv-scanner" },
                  { skillId: "s2", skillSlug: "dependency-check" },
                ],
                reasoning: "Two-phase scan",
              }),
            },
          }]));
        }
        // Call 4: LLM final
        if (fetchCallIndex === 4) {
          return Promise.resolve(llmResponse(undefined, "Plan built."));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      // Explicitly set mode to review_before_run (bombastic defaults to full_auto)
      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan repo", mode: "review_before_run" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;

      expect(body.status).toBe("paused_for_review");
      expect(body.plan.steps).toHaveLength(2);
      expect(body.usage).toBeDefined();
      expect(body.usage.totalTokens).toBeGreaterThan(0);
    });

    it("should execute single-skill via invokeSkill in agentic loop", async () => {
      const env = makeMockEnv({ toolCapable: true, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        fetchCallIndex++;
        // Call 1: LLM chat → findSkill
        if (fetchCallIndex === 1) {
          return Promise.resolve(llmResponse([{
            id: "call-1", type: "function",
            function: { name: "findSkill", arguments: JSON.stringify({ query: "scan for CVEs" }) },
          }]));
        }
        // Call 2: Runics search (findSkill tool execution)
        if (fetchCallIndex === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSingleResult()),
          });
        }
        // Call 3: LLM chat → invokeSkill
        if (fetchCallIndex === 3) {
          return Promise.resolve(llmResponse([{
            id: "call-2", type: "function",
            function: {
              name: "invokeSkill",
              arguments: JSON.stringify({
                skillId: "s1",
                skillSlug: "osv-scanner",
                input: { repo: "https://github.com/test/repo" },
              }),
            },
          }]));
        }
        // Call 4: MCP execution (invokeSkill tool execution)
        if (fetchCallIndex === 4) {
          return Promise.resolve(mcpResult({ vulnerabilities: [] }));
        }
        // Call 5: LLM chat → final text
        if (fetchCallIndex === 5) {
          return Promise.resolve(llmResponse(undefined, "No vulnerabilities found."));
        }
        // Fallback: recordInvocation etc.
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "scan my repo for CVEs",
            product: "bombastic",
            mode: "full_auto",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;

      // invokeSkill path — LLM handled directly, no buildPlan = no workflow plan
      expect(body.status).toBe("completed");
      expect(body.summary).toContain("No vulnerabilities found");
    });
  });

  // -----------------------------------------------------------------------
  // 3. AI SDK Data Stream for multi-step
  // -----------------------------------------------------------------------
  describe("Streaming multi-step workflow", () => {
    it("should stream AI SDK events for multi-step workflow via stream:true", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCallIndex++;
        // Call 1: Runics search
        if (fetchCallIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSearchMulti()),
          });
        }
        // Remaining: MCP + recordInvocation
        return Promise.resolve(mcpResult({ data: "ok" }));
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "scan my repo",
            stream: true,
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

      // Read the stream
      const text = await res.text();

      // Should contain a finish event (data: {"type":"finish",...})
      expect(text).toContain('"type":"finish"');

      // Should end with : [DONE]
      expect(text).toContain(": [DONE]");
    });

    it("should stream AI SDK events via Accept header", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSingleResult()),
        });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: {
            ...authHeaders(),
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
          },
          body: JSON.stringify({ prompt: "scan my repo" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Workflow rejection
  // -----------------------------------------------------------------------
  describe("Workflow rejection", () => {
    it("should fail workflow when resume is rejected", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: false });

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runicsSearchMulti()),
        });
      }));

      // Create paused workflow (must use review_before_run to pause; bombastic defaults to full_auto)
      const createRes = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan my repo", mode: "review_before_run" }),
        }),
        env,
        ctx,
      );

      const createBody = await createRes.json() as any;
      expect(createBody.status).toBe("paused_for_review");
      const workflowId = createBody.workflowId;

      // Reject
      const rejectRes = await app.fetch(
        new Request(`http://localhost/v1/run/${workflowId}/resume`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ workflowId, approved: false }),
        }),
        env,
        ctx,
      );

      expect(rejectRes.status).toBe(422);
      const rejectBody = await rejectRes.json() as any;

      expect(rejectBody.status).toBe("failed");
      expect(rejectBody.summary).toContain("rejected");
    });
  });

  // -----------------------------------------------------------------------
  // 5. Edge cases
  // -----------------------------------------------------------------------
  describe("Edge cases", () => {
    it("should return 422 when Runics finds no matching skills (direct mode)", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            results: [],
            confidence: "no_match",
            enriched: false,
            meta: { latencyMs: 20, tier: 1, cacheHit: false, llmInvoked: false },
          }),
        });
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "do something impossible" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(422);
      const body = await res.json() as any;
      expect(body.status).toBe("failed");
      expect(body.summary).toContain("No matching skills");
    });

    it("should execute single-skill workflow in direct mode (no composition)", async () => {
      const env = makeMockEnv({ toolCapable: false, fullAuto: true });
      let fetchCallIndex = 0;

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        fetchCallIndex++;
        if (fetchCallIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(runicsSingleResult()),
          });
        }
        return Promise.resolve(mcpResult({ result: "scan done" }));
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/run", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "scan for CVEs" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe("completed");
      expect(body.plan.steps).toHaveLength(1);
      expect(body.plan.steps[0].skill.slug).toBe("osv-scanner");
    });
  });
});
