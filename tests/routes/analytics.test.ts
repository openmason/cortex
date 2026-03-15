import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WorkflowRepository (needed by app init)
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

// ----------- Mock CF Analytics Engine API responses -----------------------

const MOCK_OVERVIEW_RESPONSE = {
  meta: [
    { name: "event", type: "String" },
    { name: "total", type: "UInt64" },
    { name: "avg_duration_ms", type: "Float64" },
    { name: "total_tokens", type: "Float64" },
    { name: "total_cost_usd", type: "Float64" },
  ],
  data: [
    { event: "request", total: 42, avg_duration_ms: 1523.5, total_tokens: 85000, total_cost_usd: 0.0312 },
    { event: "llm_call", total: 38, avg_duration_ms: 980.2, total_tokens: 78000, total_cost_usd: 0.0289 },
    { event: "skill_exec", total: 25, avg_duration_ms: 6230.1, total_tokens: 0, total_cost_usd: 0 },
  ],
  rows: 3,
};

const MOCK_REQUESTS_RESPONSE = {
  meta: [
    { name: "hour", type: "DateTime" },
    { name: "total", type: "UInt64" },
    { name: "errors", type: "UInt64" },
    { name: "avg_duration_ms", type: "Float64" },
  ],
  data: [
    { hour: "2026-03-13 05:00:00", total: 10, errors: 1, avg_duration_ms: 1200 },
    { hour: "2026-03-13 06:00:00", total: 15, errors: 0, avg_duration_ms: 980 },
  ],
  rows: 2,
};

const MOCK_SKILLS_RESPONSE = {
  meta: [
    { name: "skill", type: "String" },
    { name: "executions", type: "UInt64" },
    { name: "successes", type: "UInt64" },
    { name: "failures", type: "UInt64" },
    { name: "avg_duration_ms", type: "Float64" },
  ],
  data: [
    { skill: "doc-summarize-pro", executions: 12, successes: 11, failures: 1, avg_duration_ms: 4500 },
    { skill: "expanso-keyword-extract", executions: 8, successes: 8, failures: 0, avg_duration_ms: 7200 },
  ],
  rows: 2,
};

const MOCK_LLM_RESPONSE = {
  meta: [
    { name: "status", type: "String" },
    { name: "calls", type: "UInt64" },
    { name: "total_tokens", type: "Float64" },
    { name: "total_cost_usd", type: "Float64" },
    { name: "avg_latency_ms", type: "Float64" },
  ],
  data: [
    { status: "ok", calls: 35, total_tokens: 72000, total_cost_usd: 0.0265, avg_latency_ms: 890 },
    { status: "error", calls: 3, total_tokens: 6000, total_cost_usd: 0.0024, avg_latency_ms: 1500 },
  ],
  rows: 2,
};

const MOCK_TENANTS_RESPONSE = {
  meta: [
    { name: "tenant", type: "String" },
    { name: "product", type: "String" },
    { name: "requests", type: "UInt64" },
    { name: "tokens", type: "Float64" },
    { name: "cost_usd", type: "Float64" },
  ],
  data: [
    { tenant: "demo", product: "bombastic", requests: 30, tokens: 60000, cost_usd: 0.022 },
    { tenant: "t-test", product: "costaff", requests: 12, tokens: 25000, cost_usd: 0.009 },
  ],
  rows: 2,
};

const MOCK_ERRORS_RESPONSE = {
  meta: [
    { name: "timestamp", type: "DateTime" },
    { name: "event", type: "String" },
    { name: "skill", type: "String" },
    { name: "error", type: "String" },
    { name: "request_id", type: "String" },
  ],
  data: [
    { timestamp: "2026-03-13 06:15:00", event: "skill_exec", skill: "doc-summarize-pro", error: "Sandbox timeout", request_id: "req-abc" },
  ],
  rows: 1,
};

// Map endpoint query content to mock response
function mockResponseForQuery(sql: string): unknown {
  if (sql.includes("GROUP BY blob1")) return MOCK_OVERVIEW_RESPONSE;
  if (sql.includes("toStartOfInterval")) return MOCK_REQUESTS_RESPONSE;
  if (sql.includes("blob1 = 'skill_exec'")) return MOCK_SKILLS_RESPONSE;
  if (sql.includes("blob1 = 'llm_call'")) return MOCK_LLM_RESPONSE;
  if (sql.includes("GROUP BY index1")) return MOCK_TENANTS_RESPONSE;
  if (sql.includes("blob5 = 'error'")) return MOCK_ERRORS_RESPONSE;
  return { meta: [], data: [], rows: 0 };
}

// ----------- Helpers -------------------------------------------------------

function makeMockEnv(overrides?: Partial<Env>): Env {
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
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
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
    CF_ACCOUNT_ID: "test-account-id",
    CF_API_TOKEN: "test-api-token",
    ...overrides,
  } as Env;
}

const ADMIN_HEADERS = { Authorization: "Bearer test-admin-secret" };
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

// ----------- Tests ---------------------------------------------------------

describe("Analytics Routes", () => {
  let env: Env;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();

    // Mock global fetch to intercept CF Analytics Engine API calls
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init?) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("analytics_engine/sql")) {
        // Read the SQL body to determine which mock to return
        let body = "";
        if (init?.body && typeof init.body === "string") {
          body = init.body;
        } else if (input instanceof Request) {
          body = await input.clone().text();
        }
        return new Response(JSON.stringify(mockResponseForQuery(body)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Fall through for other fetches (e.g., LLM proxy models)
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
  });

  // ---- Auth tests ----

  it("should return 401 without Authorization header", async () => {
    const res = await app.fetch(
      new Request("http://localhost/admin/analytics/overview"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("should return 401 with wrong admin secret", async () => {
    const res = await app.fetch(
      new Request("http://localhost/admin/analytics/overview", {
        headers: { Authorization: "Bearer wrong-secret" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  // ---- Config error tests ----

  it("should return 503 when CF_ACCOUNT_ID is not configured", async () => {
    env = makeMockEnv({ CF_ACCOUNT_ID: undefined });
    const res = await app.fetch(
      new Request("http://localhost/admin/analytics/overview", { headers: ADMIN_HEADERS }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("should return 503 when CF_API_TOKEN is not configured", async () => {
    env = makeMockEnv({ CF_API_TOKEN: undefined });
    const res = await app.fetch(
      new Request("http://localhost/admin/analytics/overview", { headers: ADMIN_HEADERS }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
  });

  // ---- GET /admin/analytics/overview ----

  describe("GET /admin/analytics/overview", () => {
    it("should return event breakdown", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/overview", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.period).toBe("24h");
      expect(body.events).toHaveLength(3);
      expect(body.events[0].event).toBe("request");
      expect(body.events[0].count).toBe(42);
      expect(body.events[0].avgDurationMs).toBeTypeOf("number");
      expect(body.events[0].totalTokens).toBeTypeOf("number");
      expect(body.events[0].totalCostUsd).toBeTypeOf("number");
    });

    it("should accept ?hours param", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/overview?hours=48", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.period).toBe("48h");
    });

    it("should default to 24h for invalid hours", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/overview?hours=abc", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.period).toBe("24h");
    });

    it("should clamp hours to max 168", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/overview?hours=999", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.period).toBe("24h"); // Falls back to default
    });
  });

  // ---- GET /admin/analytics/requests ----

  describe("GET /admin/analytics/requests", () => {
    it("should return request timeseries", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/requests", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.timeseries).toHaveLength(2);
      expect(body.timeseries[0].hour).toBeDefined();
      expect(body.timeseries[0].total).toBe(10);
      expect(body.timeseries[0].errors).toBe(1);
      expect(body.timeseries[0].errorRate).toBe(10); // 1/10 = 10%
      expect(body.timeseries[0].avgDurationMs).toBe(1200);
    });
  });

  // ---- GET /admin/analytics/skills ----

  describe("GET /admin/analytics/skills", () => {
    it("should return top skills", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/skills", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.skills).toHaveLength(2);
      expect(body.skills[0].slug).toBe("doc-summarize-pro");
      expect(body.skills[0].executions).toBe(12);
      expect(body.skills[0].successes).toBe(11);
      expect(body.skills[0].failures).toBe(1);
      expect(body.skills[0].successRate).toBeCloseTo(91.67, 0);
      expect(body.skills[0].avgDurationMs).toBe(4500);
    });
  });

  // ---- GET /admin/analytics/llm ----

  describe("GET /admin/analytics/llm", () => {
    it("should return LLM usage summary", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/llm", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.llm.totalCalls).toBe(38);
      expect(body.llm.totalTokens).toBe(78000);
      expect(body.llm.totalCostUsd).toBeGreaterThan(0);
      expect(body.llm.avgLatencyMs).toBeTypeOf("number");
      expect(body.llm.errorRate).toBeCloseTo(7.89, 0);
      expect(body.llm.breakdown).toHaveLength(2);
    });
  });

  // ---- GET /admin/analytics/tenants ----

  describe("GET /admin/analytics/tenants", () => {
    it("should return per-tenant breakdown", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/tenants", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.tenants).toHaveLength(2);
      expect(body.tenants[0].tenantId).toBe("demo");
      expect(body.tenants[0].product).toBe("bombastic");
      expect(body.tenants[0].requests).toBe(30);
    });
  });

  // ---- GET /admin/analytics/errors ----

  describe("GET /admin/analytics/errors", () => {
    it("should return recent errors", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/analytics/errors", { headers: ADMIN_HEADERS }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].event).toBe("skill_exec");
      expect(body.errors[0].skill).toBe("doc-summarize-pro");
      expect(body.errors[0].error).toBe("Sandbox timeout");
      expect(body.errors[0].requestId).toBe("req-abc");
    });
  });

  // ---- CF API error handling ----

  it("should return 500 when CF API returns an error", async () => {
    fetchSpy.mockImplementation(async () => {
      return new Response("Forbidden", { status: 403 });
    });
    const res = await app.fetch(
      new Request("http://localhost/admin/analytics/overview", { headers: ADMIN_HEADERS }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("403");
  });
});
