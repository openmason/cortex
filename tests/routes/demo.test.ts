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

import app from "../../src/index";
import type { Env } from "../../src/types";

function makeMockEnv(): Env {
  return {
    SESSION_CACHE: {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: { get: vi.fn() } as unknown as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
    COGNIUM_URL: "https://cognium.test.local",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "test-model",
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

describe("Demo Page", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should return 200 with text/html content type", async () => {
    const res = await app.fetch(
      new Request("http://localhost/demo"),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("should contain expected HTML structure", async () => {
    const res = await app.fetch(
      new Request("http://localhost/demo"),
      env,
      ctx,
    );

    const body = await res.text();
    expect(body).toContain("<title>Cortex Demo</title>");
    expect(body).toContain('id="tl"');
    expect(body).toContain('id="key"');
    expect(body).toContain('id="go"');
    expect(body).toContain('class="plan-viz"');
  });

  it("should not require authentication", async () => {
    // No Authorization header — should still return 200, not 401
    const res = await app.fetch(
      new Request("http://localhost/demo"),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
  });
});
