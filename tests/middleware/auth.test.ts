import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env, AppVariables } from "../../src/types";

// Mock WorkflowRepository
const mockGetApiKey = vi.fn().mockResolvedValue(null);

vi.mock("../../src/db/repository", () => ({
  WorkflowRepository: vi.fn().mockImplementation(() => ({
    getApiKey: mockGetApiKey,
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  })),
}));

import { authMiddleware, requireScope } from "../../src/middleware/auth";

const TEST_KEY = "ctx_testapikey1234567890abcdef";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("/*", authMiddleware);
  app.get("/test", (c) =>
    c.json({
      tenantId: c.get("tenantId"),
      userId: c.get("userId"),
      product: c.get("product"),
      scopes: c.get("scopes"),
    }),
  );
  return app;
}

function makeMockEnv(seedKey = true): Env {
  const store = new Map<string, string>();

  if (seedKey) {
    store.set(
      `apikey:${TEST_KEY}`,
      JSON.stringify({
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        scopes: ["run", "sessions"],
        createdAt: new Date().toISOString(),
      }),
    );
  }

  return {
    SESSION_CACHE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {} as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    FORGE_QUEUE: {} as Queue,
    COGNIUM_QUEUE: {} as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "",
    COGNIUM_URL: "",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "",
    LLMPROXY_API_KEY: "",
    DAYTONA_API_KEY: "",
    DATABASE_URL: "",
    ADMIN_SECRET: "test-secret",
  } as Env;
}

describe("Auth Middleware", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    mockGetApiKey.mockResolvedValue(null);
  });

  it("should return 401 when no Authorization header", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/test"), env, ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/Missing/);
  });

  it("should return 401 when Authorization is not Bearer", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Basic abc123" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("should return 401 when Bearer token is empty", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer " },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("should return 401 when key not found in KV or DB", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_nonexistent" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/Invalid API key/);
  });

  it("should fall through to DB when KV value is corrupted JSON", async () => {
    env = makeMockEnv(false);
    (env.SESSION_CACHE.get as any).mockResolvedValue("not-json{{{");
    const app = makeApp();
    // DB also returns null → 401
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_baddata" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("should inject context variables on valid KV key", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tenantId).toBe("t1");
    expect(body.userId).toBe("u1");
    expect(body.product).toBe("bombastic");
    expect(body.scopes).toEqual(["run", "sessions"]);
  });

  it("should call KV.get with correct key format", async () => {
    const app = makeApp();
    await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    expect(env.SESSION_CACHE.get).toHaveBeenCalledWith(`apikey:${TEST_KEY}`);
  });

  // -------------------------------------------------------------------------
  // DB fallback tests
  // -------------------------------------------------------------------------

  it("should query DB when KV misses and return 200 on DB hit", async () => {
    env = makeMockEnv(false); // No key in KV
    mockGetApiKey.mockResolvedValue({
      tenantId: "db-tenant",
      userId: "db-user",
      product: "costaff",
      scopes: ["run"],
      createdAt: new Date().toISOString(),
    });

    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_dbonly" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tenantId).toBe("db-tenant");
    expect(body.product).toBe("costaff");
  });

  it("should backfill KV cache on DB hit", async () => {
    env = makeMockEnv(false);
    mockGetApiKey.mockResolvedValue({
      tenantId: "db-tenant",
      userId: "db-user",
      product: "costaff",
      scopes: ["run"],
      createdAt: new Date().toISOString(),
    });

    const app = makeApp();
    await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_dbonly" },
      }),
      env,
      ctx,
    );

    expect(env.SESSION_CACHE.put).toHaveBeenCalledWith(
      "apikey:ctx_dbonly",
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  it("should return 401 when both KV and DB miss", async () => {
    env = makeMockEnv(false);
    mockGetApiKey.mockResolvedValue(null);

    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_nowhere" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("should not query DB when KV cache hits", async () => {
    const app = makeApp();
    await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    // DB should NOT have been called since KV hit
    expect(mockGetApiKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requireScope middleware
// ---------------------------------------------------------------------------
describe("requireScope", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  function makeScopedApp(scope: string) {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("/*", authMiddleware);
    app.use("/*", requireScope(scope));
    app.get("/protected", (c) => c.json({ ok: true }));
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv(); // key has scopes: ["run", "sessions"]
    mockGetApiKey.mockResolvedValue(null);
  });

  it("should pass when key has the required scope", async () => {
    const app = makeScopedApp("run");
    const res = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("should return 403 when key lacks the required scope", async () => {
    const app = makeScopedApp("skills");
    const res = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toContain("skills");
  });

  it("should pass when key has multiple scopes including the required one", async () => {
    const app = makeScopedApp("sessions");
    const res = await app.fetch(
      new Request("http://localhost/protected", {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
  });
});
