import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateApiKey = vi.fn().mockResolvedValue(undefined);
const mockRevokeApiKey = vi.fn().mockResolvedValue(undefined);
const mockGetApiKey = vi.fn().mockResolvedValue(null);

vi.mock("../../src/db/repository", () => ({
  WorkflowRepository: vi.fn().mockImplementation(() => ({
    createApiKey: mockCreateApiKey,
    revokeApiKey: mockRevokeApiKey,
    getApiKey: mockGetApiKey,
    loadPolicy: vi.fn().mockResolvedValue(null),
    upsertPolicy: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    recordStepExecution: vi.fn(),
    writeTrace: vi.fn(),
    markTraceAsSaved: vi.fn(),
  })),
}));

import app from "../../src/index";
import type { Env } from "../../src/types";

const TEST_ADMIN_SECRET = "test-admin-secret";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();

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
    R2_BUCKET: {} as R2Bucket,
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
    ADMIN_SECRET: TEST_ADMIN_SECRET,
  } as Env;
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_ADMIN_SECRET}` };
}

describe("Admin Routes", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateApiKey.mockResolvedValue(undefined);
    mockRevokeApiKey.mockResolvedValue(undefined);
    mockGetApiKey.mockResolvedValue(null);
    env = makeMockEnv();
  });

  describe("Admin auth", () => {
    it("should return 401 without admin secret", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t1",
            userId: "u1",
            product: "bombastic",
          }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should return 401 with wrong admin secret", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: {
            Authorization: "Bearer wrong-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tenantId: "t1",
            userId: "u1",
            product: "bombastic",
          }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });
  });

  describe("POST /admin/api-keys", () => {
    it("should create an API key", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t1",
            userId: "u1",
            product: "bombastic",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.key).toMatch(/^ctx_/);
      expect(body.key.length).toBeGreaterThan(4);
      expect(body.tenantId).toBe("t1");
      expect(body.userId).toBe("u1");
      expect(body.product).toBe("bombastic");
      expect(body.scopes).toEqual(["workflows", "sessions"]);
      expect(body.createdAt).toBeDefined();

      // Verify it was persisted to DB
      expect(mockCreateApiKey).toHaveBeenCalledOnce();
      expect(mockCreateApiKey).toHaveBeenCalledWith(
        body.key,
        expect.objectContaining({
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          scopes: ["workflows", "sessions"],
        }),
      );

      // Verify KV write-through cache
      expect(env.SESSION_CACHE.put).toHaveBeenCalledOnce();
      const putCall = (env.SESSION_CACHE.put as any).mock.calls[0];
      expect(putCall[0]).toBe(`apikey:${body.key}`);
    });

    it("should create key with custom scopes", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t2",
            userId: "u2",
            product: "controlcenter",
            scopes: ["workflows"],
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toEqual(["workflows"]);
      expect(body.product).toBe("controlcenter");

      // Verify DB persistence with custom scopes
      expect(mockCreateApiKey).toHaveBeenCalledWith(
        body.key,
        expect.objectContaining({
          tenantId: "t2",
          userId: "u2",
          product: "controlcenter",
          scopes: ["workflows"],
        }),
      );
    });

    it("should reject invalid product", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t1",
            userId: "u1",
            product: "invalid",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should reject missing tenantId", async () => {
      const res = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "u1",
            product: "bombastic",
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /admin/api-keys/:key", () => {
    it("should delete an API key", async () => {
      const res = await app.fetch(
        new Request(
          "http://localhost/admin/api-keys/ctx_somekey12345",
          {
            method: "DELETE",
            headers: adminHeaders(),
          },
        ),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deleted).toBe(true);

      // Verify DB soft-delete
      expect(mockRevokeApiKey).toHaveBeenCalledOnce();
      expect(mockRevokeApiKey).toHaveBeenCalledWith("ctx_somekey12345");

      // Verify KV cache eviction
      expect(env.SESSION_CACHE.delete).toHaveBeenCalledWith(
        "apikey:ctx_somekey12345",
      );
    });
  });

  describe("API key round-trip", () => {
    it("should create a key then use it for auth", async () => {
      // Stub fetch so /v1/models doesn't hang
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          object: "list",
          data: [{ id: "test-model", object: "model", owned_by: "test" }],
        }),
      }));

      // Create key
      const createRes = await app.fetch(
        new Request("http://localhost/admin/api-keys", {
          method: "POST",
          headers: { ...adminHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t-roundtrip",
            userId: "u-roundtrip",
            product: "costaff",
          }),
        }),
        env,
        ctx,
      );

      expect(createRes.status).toBe(201);
      const { key } = (await createRes.json()) as any;

      // Use the created key to call a /v1 route
      const res = await app.fetch(
        new Request("http://localhost/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        }),
        env,
        ctx,
      );

      // Auth passed — should get 200 (not 401)
      expect(res.status).toBe(200);
    });
  });
});
