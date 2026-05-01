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

describe("POST /v1/approvals", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should require auth for approve", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/approvals/wf_123/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("should require auth for reject", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/approvals/wf_123/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("should return 422 for non-existent workflow on approve", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/approvals/wf_nonexistent/approve", {
        method: "POST",
        headers: authHeaders(),
      }),
      env,
      ctx,
    );

    // handleResume returns { status: "failed" } for missing workflows → 422
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.status).toBe("failed");
  });

  it("should return 422 for non-existent workflow on reject", async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/approvals/wf_nonexistent/reject", {
        method: "POST",
        headers: authHeaders(),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.status).toBe("failed");
  });

  it("should approve a paused workflow", async () => {
    // Seed a paused workflow in WORKFLOW_STATE
    const workflowId = "wf_test_approve";
    const workflowState = {
      id: workflowId,
      status: "paused_for_review",
      request: {
        prompt: "test",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      },
      plan: {
        steps: [{
          skillSlug: "test-skill",
          skillId: "s1",
          executionLayer: "mcp-remote",
          mcpUrl: "https://mcp.example.com",
          inputMapping: {},
          description: "Test step",
        }],
        reasoning: "test",
        estimatedTurns: 1,
      },
      results: [],
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 300000).toISOString(),
    };

    await env.WORKFLOW_STATE.put(`workflow:${workflowId}`, JSON.stringify(workflowState));

    // Mock fetch for any LLM/execution calls during resume
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: "executed" }),
    }));

    const res = await app.fetch(
      new Request(`http://localhost/v1/approvals/${workflowId}/approve`, {
        method: "POST",
        headers: authHeaders(),
      }),
      env,
      ctx,
    );

    const body = await res.json();
    // Approval should succeed (status could be "completed" or "running")
    expect(res.status).toBe(200);
    expect(body.status).not.toBe("failed");
  });

  it("should reject a paused workflow", async () => {
    // Seed a paused workflow in WORKFLOW_STATE
    const workflowId = "wf_test_reject";
    const workflowState = {
      id: workflowId,
      status: "paused_for_review",
      request: {
        prompt: "test",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
      },
      plan: {
        steps: [{
          skillSlug: "test-skill",
          skillId: "s1",
          executionLayer: "mcp-remote",
          mcpUrl: "https://mcp.example.com",
          inputMapping: {},
          description: "Test step",
        }],
        reasoning: "test",
        estimatedTurns: 1,
      },
      results: [],
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 300000).toISOString(),
    };

    await env.WORKFLOW_STATE.put(`workflow:${workflowId}`, JSON.stringify(workflowState));

    const res = await app.fetch(
      new Request(`http://localhost/v1/approvals/${workflowId}/reject`, {
        method: "POST",
        headers: authHeaders(),
      }),
      env,
      ctx,
    );

    const body = await res.json();
    // Rejection sets status to "failed" → 422
    expect(res.status).toBe(422);
    expect(body.status).toBe("failed");
    expect(body.summary).toContain("Workflow rejected by human reviewer");
  });
});
