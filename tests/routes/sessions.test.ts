import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/types";

const TEST_API_KEY = "ctx_testapikey1234567890abcdef";
const TEST_ADMIN_SECRET = "test-admin-secret";

// Mock WorkflowRepository to avoid real DB calls
vi.mock("../../src/db/repository", () => {
  const mockRepo = {
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi.fn().mockResolvedValue(null),
    getSessionTrace: vi.fn().mockResolvedValue(null),
    loadPolicy: vi.fn().mockResolvedValue(null),
    upsertPolicy: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    recordStepExecution: vi.fn(),
    writeTrace: vi.fn(),
    markTraceAsSaved: vi.fn(),
    getApiKey: vi.fn().mockResolvedValue(null),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  };
  return {
    WorkflowRepository: vi.fn().mockImplementation(() => mockRepo),
    __mockRepo: mockRepo,
  };
});

import { WorkflowRepository, __mockRepo } from "../../src/db/repository";

const mockRepo = __mockRepo as any;

function makeMockEnv(): Env {
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
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as KVNamespace,
    HYPERDRIVE: { connectionString: "postgresql://test:test@localhost/test" } as unknown as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test",
    COGNIUM_URL: "https://cognium.test",
    DAYTONA_URL: "https://daytona.test",
    LLM_MODEL: "cognium/claude-sonnet-latest",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llmproxy.test",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_SECRET: TEST_ADMIN_SECRET,
  } as Env;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

describe("Session Routes", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    // Re-seed API key since clearAllMocks resets mock implementations
    (env.SESSION_CACHE.get as any).mockImplementation(async (key: string) => {
      if (key === `apikey:${TEST_API_KEY}`) {
        return JSON.stringify({
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          scopes: ["run", "sessions"],
          createdAt: new Date().toISOString(),
        });
      }
      return null;
    });
  });

  describe("GET /v1/sessions", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/sessions"),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should return empty list when no sessions", async () => {
      mockRepo.listSessions.mockResolvedValue([]);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.sessions).toEqual([]);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
    });

    it("should return sessions list", async () => {
      const sessions = [
        {
          id: "s1",
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          status: "completed",
          prompt: "test",
          createdAt: new Date().toISOString(),
        },
        {
          id: "s2",
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          status: "running",
          prompt: "test 2",
          createdAt: new Date().toISOString(),
        },
      ];
      mockRepo.listSessions.mockResolvedValue(sessions);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.sessions).toHaveLength(2);
    });

    it("should pass query params to repo", async () => {
      mockRepo.listSessions.mockResolvedValue([]);

      await app.fetch(
        new Request("http://localhost/v1/sessions?status=completed&product=costaff&limit=5&offset=10", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(mockRepo.listSessions).toHaveBeenCalledWith(
        "t1",
        { status: "completed", product: "costaff" },
        5,
        10,
      );
    });

    it("should cap limit at 100", async () => {
      mockRepo.listSessions.mockResolvedValue([]);

      await app.fetch(
        new Request("http://localhost/v1/sessions?limit=500", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(mockRepo.listSessions).toHaveBeenCalledWith(
        "t1",
        { status: undefined, product: undefined },
        100,
        0,
      );
    });
  });

  describe("GET /v1/sessions/:id", () => {
    it("should return 404 when session not found", async () => {
      mockRepo.getSessionDetail.mockResolvedValue(null);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions/nonexistent", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should return session detail with steps", async () => {
      const detail = {
        id: "s1",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        status: "completed",
        prompt: "test",
        steps: [
          {
            id: "step1",
            sessionId: "s1",
            stepOrder: 0,
            skillSlug: "test-skill",
            status: "completed",
          },
        ],
      };
      mockRepo.getSessionDetail.mockResolvedValue(detail);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions/s1", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("s1");
      expect(body.steps).toHaveLength(1);
    });

    it("should scope by tenant", async () => {
      mockRepo.getSessionDetail.mockResolvedValue(null);

      await app.fetch(
        new Request("http://localhost/v1/sessions/s1", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(mockRepo.getSessionDetail).toHaveBeenCalledWith("s1", "t1");
    });
  });

  describe("GET /v1/sessions/:id/trace", () => {
    it("should return 404 when trace not found", async () => {
      mockRepo.getSessionTrace.mockResolvedValue(null);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions/s1/trace", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should return trace data", async () => {
      const trace = {
        id: "tr1",
        sessionId: "s1",
        tenantId: "t1",
        product: "bombastic",
        prompt: "test",
        planJson: {},
        stepsExecuted: [],
        totalDurationMs: 500,
        success: true,
      };
      mockRepo.getSessionTrace.mockResolvedValue(trace);

      const res = await app.fetch(
        new Request("http://localhost/v1/sessions/s1/trace", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.sessionId).toBe("s1");
      expect(body.success).toBe(true);
    });

    it("should scope by tenant", async () => {
      mockRepo.getSessionTrace.mockResolvedValue(null);

      await app.fetch(
        new Request("http://localhost/v1/sessions/s1/trace", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(mockRepo.getSessionTrace).toHaveBeenCalledWith("s1", "t1");
    });
  });
});
