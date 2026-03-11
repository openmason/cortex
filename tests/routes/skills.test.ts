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

  sessionStore.set(
    `apikey:${TEST_API_KEY}`,
    JSON.stringify({
      tenantId: "t1",
      userId: "u1",
      product: "bombastic",
      scopes: ["run", "sessions", "skills"],
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
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
    COGNIUM_URL: "https://circle.cognium.net",
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

const MOCK_COMPOSITE = {
  id: "sk1",
  slug: "security-review",
  version: "1.0.0",
  name: "Security Review",
  executionLayer: "composite",
  skillType: "human-composite",
  trustScore: 0.82,
  verificationTier: "verified",
  trustBadge: "human-verified",
  status: "published",
  runCount: 10,
  description: "Comprehensive security review",
  tags: ["security", "rust"],
  category: "code-quality",
  visibility: "team",
  tenantId: "t1",
  createdAt: "2025-01-01T00:00:00Z",
  compositionSteps: [
    { stepOrder: 0, skillId: "s1", skillSlug: "cargo-clippy", skillVersion: "1.0.0", stepName: "Cargo Clippy", onError: "fail" },
    { stepOrder: 1, skillId: "s2", skillSlug: "cargo-audit", skillVersion: "2.0.0", stepName: "Cargo Audit", onError: "fail" },
  ],
  compositionSkillIds: ["s1", "s2"],
};

describe("Composite Skill Routes", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  // -------------------------------------------------------------------------
  // GET /v1/skills/composites
  // -------------------------------------------------------------------------
  describe("GET /v1/skills/composites", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites"),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should return 403 when API key lacks skills scope", async () => {
      // Seed a key without skills scope
      const noSkillsKey = "ctx_noskillskey1234567890abcdef";
      (env.SESSION_CACHE.put as any)(
        `apikey:${noSkillsKey}`,
        JSON.stringify({
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          scopes: ["run", "sessions"],
          createdAt: new Date().toISOString(),
        }),
      );

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites", {
          headers: { Authorization: `Bearer ${noSkillsKey}` },
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toContain("skills");
    });

    it("should return paginated list of composites", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          skills: [MOCK_COMPOSITE],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.skills).toHaveLength(1);
      expect(body.skills[0].slug).toBe("security-review");
      expect(body.total).toBe(1);
    });

    it("should pass status filter and pagination to Runics", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ skills: [], total: 0, limit: 10, offset: 5 }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites?status=deprecated&limit=10&offset=5", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("status=deprecated");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=5");
    });

    it("should cap limit at 100", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ skills: [], total: 0, limit: 100, offset: 0 }),
      }));

      await app.fetch(
        new Request("http://localhost/v1/skills/composites?limit=500", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("limit=100");
    });

    it("should return 502 when Runics is unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(502);
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/skills/composites/:slug
  // -------------------------------------------------------------------------
  describe("GET /v1/skills/composites/:slug", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review"),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should return composite detail with steps", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_COMPOSITE),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.slug).toBe("security-review");
      expect(body.compositionSteps).toHaveLength(2);
      expect(body.compositionSteps[0].skillSlug).toBe("cargo-clippy");
    });

    it("should return 404 when composite not found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/nonexistent", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toContain("not found");
    });

    it("should pass version query param", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_COMPOSITE),
      }));

      await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review?version=2.0.0", {
          headers: authHeaders(),
        }),
        env,
        ctx,
      );

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("/security-review/2.0.0?include=steps");
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/skills/composites/:slug
  // -------------------------------------------------------------------------
  describe("PATCH /v1/skills/composites/:slug", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "New Name" }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should reject empty update body", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should reject description that is too short", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ description: "short" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should update composite metadata successfully", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...MOCK_COMPOSITE, name: "Updated Review" }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Updated Review" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe("Updated Review");
    });

    it("should return 404 when composite not found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/nonexistent", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Test" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should return 403 when tenant does not own the composite", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/other-review", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Hijack" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(403);
    });

    it("should accept partial updates (tags only)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ...MOCK_COMPOSITE, tags: ["new-tag"] }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review", {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ tags: ["new-tag"] }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.tags).toEqual(["new-tag"]);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/skills/composites/:slug/deprecate
  // -------------------------------------------------------------------------
  describe("POST /v1/skills/composites/:slug/deprecate", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/deprecate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should deprecate a composite successfully", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ slug: "security-review", status: "deprecated" }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review/deprecate", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Superseded by v2" }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe("deprecated");
    });

    it("should accept empty body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ slug: "review", status: "deprecated" }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/deprecate", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
    });

    it("should return 404 when composite not found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/nonexistent/deprecate", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should return 403 when tenant does not own the composite", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/other-review/deprecate", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/skills/composites/:slug/fork
  // -------------------------------------------------------------------------
  describe("POST /v1/skills/composites/:slug/fork", () => {
    it("should require auth", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/fork", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: ["added cargo-deny"] }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("should reject fork without changes array", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/fork", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should reject fork with empty changes array", async () => {
      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/fork", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ changes: [] }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(400);
    });

    it("should fork a composite successfully", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "forked-1",
          slug: "security-review-v2",
          version: "1.0.0",
          forkedFrom: "security-review@1.0.0",
          trustScore: 0.5,
          status: "draft",
          skillType: "forked",
        }),
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/security-review/fork", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            changes: ["added cargo-deny", "removed clippy"],
            modifications: { removeSteps: [0] },
          }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBe("forked-1");
      expect(body.skillType).toBe("forked");
      expect(body.status).toBe("draft");
      expect(body.forkedFrom).toBe("security-review@1.0.0");
    });

    it("should return 404 when source composite not found", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const res = await app.fetch(
        new Request("http://localhost/v1/skills/composites/nonexistent/fork", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ changes: ["test"] }),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(404);
    });

    it("should pass userId as forkedBy to Runics", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "forked-1", slug: "review-v2", version: "1.0.0",
          forkedFrom: "review@1.0.0", trustScore: 0.5, status: "draft", skillType: "forked",
        }),
      }));

      await app.fetch(
        new Request("http://localhost/v1/skills/composites/review/fork", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ changes: ["minor tweak"] }),
        }),
        env,
        ctx,
      );

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.forkedBy).toBe("u1");
      expect(body.tenantId).toBe("t1");
    });
  });
});
