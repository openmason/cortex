import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requireScope } from "../../src/middleware/auth";
import type { Env, AppVariables } from "../../src/types";

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
    DAYTONA_URL: "",
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

  it("should return 401 when API key not found in KV", async () => {
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

  it("should return 500 when KV value is corrupted JSON", async () => {
    env = makeMockEnv(false);
    (env.SESSION_CACHE.get as any).mockResolvedValue("not-json{{{");
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/test", {
        headers: { Authorization: "Bearer ctx_baddata" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/Corrupted/);
  });

  it("should inject context variables on valid key", async () => {
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
