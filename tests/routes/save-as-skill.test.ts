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

const TEST_API_KEY = "ctx_testapikey1234567890abcdef";
const TEST_ADMIN_SECRET = "test-admin-secret";

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
    RUNICS_URL: "https://runics.test.local",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "test-model",
    DEFAULT_EXECUTION_MODE: "full_auto",
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

function seedWorkflow(env: Env, workflowId: string, overrides: Record<string, unknown> = {}) {
  const state = {
    workflowId,
    tenantId: "t1",
    userId: "u1",
    product: "bombastic",
    mode: "full_auto",
    plan: {
      id: "plan-1",
      steps: [
        {
          id: "step-1",
          order: 0,
          skill: {
            id: "s1", slug: "cargo-clippy", version: "1.0.0", name: "Cargo Clippy",
            executionLayer: "mcp-remote", trustScore: 0.9, verificationTier: "verified",
            trustBadge: null, status: "published", skillType: "atomic", runCount: 50,
          },
          onError: "fail",
          status: "completed",
          result: { success: true, output: { warnings: 0 }, durationMs: 200, layer: "mcp-remote" },
        },
        {
          id: "step-2",
          order: 1,
          skill: {
            id: "s2", slug: "cargo-audit", version: "2.0.0", name: "Cargo Audit",
            executionLayer: "container", trustScore: 0.85, verificationTier: "verified",
            trustBadge: "upstream", status: "published", skillType: "atomic", runCount: 100,
          },
          onError: "fail",
          status: "completed",
          result: { success: true, output: { vulnerabilities: 0 }, durationMs: 500, layer: "container" },
        },
      ],
      mode: "full_auto",
      createdAt: new Date().toISOString(),
    },
    currentStepIndex: 2,
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };

  (env.WORKFLOW_STATE as any).put(`workflow:${workflowId}`, JSON.stringify(state));
  return state;
}

describe("POST /v1/workflows/:workflowId/save", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should reject missing required fields", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-1/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("should reject description that is too short", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-1/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", description: "short" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("should return 404 when workflow not found", async () => {
    // Mock fetch for LLM alt-query call (won't be reached, but prevent unhandled)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/nonexistent/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Skill",
          description: "A test skill for testing the save flow",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain("not found");
  });

  it("should return 422 when workflow is not completed", async () => {
    seedWorkflow(env, "wf-running", { status: "running" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-running/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Skill",
          description: "A test skill for testing the save flow",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain("running");
  });

  it("should return 403 when tenant doesn't own the workflow", async () => {
    seedWorkflow(env, "wf-other", { tenantId: "other-tenant" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-other/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Skill",
          description: "A test skill for testing the save flow",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain("Unauthorized");
  });

  it("should save a completed workflow and return enriched response", async () => {
    seedWorkflow(env, "wf-complete");

    // Mock: LLM for alt-queries, then Runics publish
    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCallIndex++;
      if (fetchCallIndex === 1) {
        // LLM alt-query generation
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "chatcmpl-1",
            choices: [{ message: { content: '["security check","audit code"]' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        });
      }
      // Runics publish
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "published-skill-1", slug: "security-review" }),
      });
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-complete/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Security Review",
          description: "Comprehensive security review for Rust code",
          visibility: "team",
          tags: ["security", "rust"],
          category: "code-quality",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.skillId).toBe("published-skill-1");
    expect(body.slug).toBe("security-review");
    expect(body.name).toBe("Security Review");
    expect(body.version).toBe("1.0.0");
    expect(body.trustScore).toBeTypeOf("number");
    expect(body.composedFrom).toHaveLength(2);
    expect(body.composedFrom[0].slug).toBe("cargo-clippy");
    expect(body.composedFrom[1].slug).toBe("cargo-audit");
    expect(body.executionLayer).toBe("composite");
    expect(body.skillType).toBe("human-composite");
    expect(body.trustBadge).toBe("human-verified");
    expect(body.visibility).toBe("team");
  });

  it("should default visibility to team", async () => {
    seedWorkflow(env, "wf-default");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "s1", slug: "test" }),
    }));

    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-default/save", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Default Vis",
          description: "Testing default visibility value",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.visibility).toBe("team");
  });

  it("should require auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/workflows/wf-1/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          description: "A test skill for testing",
        }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });
});
