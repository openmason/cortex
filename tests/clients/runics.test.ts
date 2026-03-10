import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunicsClient } from "../../src/clients/runics";

function makeEnv() {
  return {
    RUNICS_URL: "https://runics.test.local",
  } as any;
}

describe("RunicsClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // findSkill — userId visibility
  // -------------------------------------------------------------------------
  describe("findSkill", () => {
    it("should pass userId in the search body when provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          confidence: "no_match",
          enriched: false,
          meta: { latencyMs: 10, tier: 1, cacheHit: false, llmInvoked: false },
        }),
      }));

      const client = new RunicsClient(makeEnv());
      await client.findSkill({
        query: "security check",
        tenantId: "t1",
        userId: "u1",
      });

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.userId).toBe("u1");
      expect(body.tenantId).toBe("t1");
    });

    it("should omit userId when not provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          confidence: "no_match",
          enriched: false,
          meta: { latencyMs: 10, tier: 1, cacheHit: false, llmInvoked: false },
        }),
      }));

      const client = new RunicsClient(makeEnv());
      await client.findSkill({
        query: "security check",
        tenantId: "t1",
      });

      const call = (fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.userId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listComposites
  // -------------------------------------------------------------------------
  describe("listComposites", () => {
    it("should call GET /v1/skills with correct query params", async () => {
      const mockResponse = {
        skills: [{ id: "s1", slug: "security-review" }],
        total: 1,
        limit: 20,
        offset: 0,
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.listComposites("t1", { status: "published", limit: 10, offset: 5 });

      expect(result.skills).toHaveLength(1);
      expect(result.total).toBe(1);

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("/v1/skills?");
      expect(url).toContain("tenantId=t1");
      expect(url).toContain("skillType=human-composite");
      expect(url).toContain("status=published");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=5");
    });

    it("should pass userId in query params when provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ skills: [], total: 0, limit: 20, offset: 0 }),
      }));

      const client = new RunicsClient(makeEnv());
      await client.listComposites("t1", { userId: "u1" });

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("userId=u1");
    });

    it("should throw on non-OK response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.listComposites("t1")).rejects.toThrow("Runics listComposites failed: 500");
    });
  });

  // -------------------------------------------------------------------------
  // getCompositeDetail
  // -------------------------------------------------------------------------
  describe("getCompositeDetail", () => {
    it("should call GET /v1/skills/:slug?include=steps", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "s1", slug: "review", compositionSteps: [] }),
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.getCompositeDetail("review");

      expect(result).not.toBeNull();
      expect(result!.slug).toBe("review");

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("/v1/skills/review?include=steps");
    });

    it("should include version in path when provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "s1", slug: "review" }),
      }));

      const client = new RunicsClient(makeEnv());
      await client.getCompositeDetail("review", "2.0.0");

      const url = (fetch as any).mock.calls[0][0];
      expect(url).toContain("/v1/skills/review/2.0.0?include=steps");
    });

    it("should return null for 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.getCompositeDetail("nonexistent");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // updateComposite
  // -------------------------------------------------------------------------
  describe("updateComposite", () => {
    it("should call PATCH /v1/skills/:slug with body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "s1", slug: "review", name: "Updated" }),
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.updateComposite("review", "t1", { name: "Updated" });

      expect(result.name).toBe("Updated");

      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toContain("/v1/skills/review");
      expect(call[1].method).toBe("PATCH");
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe("Updated");
      expect(body.tenantId).toBe("t1");
    });

    it("should throw 'not found' on 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.updateComposite("nope", "t1", { name: "X" }))
        .rejects.toThrow("Composite skill not found");
    });

    it("should throw 'Unauthorized' on 403", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.updateComposite("review", "wrong-tenant", { name: "X" }))
        .rejects.toThrow("Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // deprecateComposite
  // -------------------------------------------------------------------------
  describe("deprecateComposite", () => {
    it("should call POST /v1/skills/:slug/deprecate", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ slug: "review", status: "deprecated" }),
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.deprecateComposite("review", "t1", "Superseded", "review-v2");

      expect(result.status).toBe("deprecated");

      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toContain("/v1/skills/review/deprecate");
      expect(call[1].method).toBe("POST");
      const body = JSON.parse(call[1].body);
      expect(body.reason).toBe("Superseded");
      expect(body.replacementSkillSlug).toBe("review-v2");
      expect(body.tenantId).toBe("t1");
    });

    it("should throw 'not found' on 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.deprecateComposite("nope", "t1"))
        .rejects.toThrow("Composite skill not found");
    });

    it("should throw 'Unauthorized' on 403", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.deprecateComposite("review", "wrong"))
        .rejects.toThrow("Unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // forkComposite
  // -------------------------------------------------------------------------
  describe("forkComposite", () => {
    it("should call POST /v1/skills/:slug/fork with correct body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          id: "forked-1",
          slug: "review-v2",
          version: "1.0.0",
          forkedFrom: "review@1.0.0",
          trustScore: 0.5,
          status: "draft",
          skillType: "forked",
        }),
      }));

      const client = new RunicsClient(makeEnv());
      const result = await client.forkComposite("review", "t1", "u1", {
        changes: ["added cargo-deny"],
        modifications: { removeSteps: [2] },
      });

      expect(result.id).toBe("forked-1");
      expect(result.skillType).toBe("forked");
      expect(result.status).toBe("draft");

      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toContain("/v1/skills/review/fork");
      expect(call[1].method).toBe("POST");
      const body = JSON.parse(call[1].body);
      expect(body.changes).toEqual(["added cargo-deny"]);
      expect(body.tenantId).toBe("t1");
      expect(body.forkedBy).toBe("u1");
      expect(body.modifications.removeSteps).toEqual([2]);
    });

    it("should throw 'not found' on 404", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }));

      const client = new RunicsClient(makeEnv());
      await expect(client.forkComposite("nope", "t1", "u1", { changes: ["x"] }))
        .rejects.toThrow("Composite skill not found");
    });
  });
});
