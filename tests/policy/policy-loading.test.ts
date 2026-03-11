import { describe, it, expect, vi, beforeEach } from "vitest";
import { PolicyEngine, defaultPolicy } from "../../src/policy/engine";
import type { Env } from "../../src/types";

/**
 * Tests for PolicyEngine.loadPolicy() — the cache → DB → default chain.
 *
 * We mock SESSION_CACHE (KV) and WorkflowRepository to test each layer.
 * WorkflowRepository is mocked at the module level since PolicyEngine
 * instantiates it internally.
 */

// Mock WorkflowRepository
vi.mock("../../src/db/repository", () => {
  return {
    WorkflowRepository: vi.fn().mockImplementation(() => ({
      loadPolicy: vi.fn().mockResolvedValue(null),
    })),
  };
});

import { WorkflowRepository } from "../../src/db/repository";

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();

  return {
    SESSION_CACHE: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    } as unknown as KVNamespace,
    WORKFLOW_STATE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    } as unknown as KVNamespace,
    HYPERDRIVE: { connectionString: "postgresql://test:test@localhost/test" } as unknown as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "",
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
    ADMIN_SECRET: "test",
  } as Env;
}

describe("PolicyEngine.loadPolicy", () => {
  let env: Env;
  let engine: PolicyEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    engine = new PolicyEngine(env);
  });

  it("should return cached policy from KV when available", async () => {
    const cachedPolicy = {
      tenantId: "t1",
      product: "costaff",
      defaultMode: "step_by_step",
      defaultAppetite: "strict",
      trustFloor: 0.9,
      enableHumanReview: true,
      sensitiveCategories: ["filesystem"],
      blockedSkillSlugs: ["bad-skill"],
      maxConcurrentWorkflows: 5,
    };

    (env.SESSION_CACHE.get as any).mockResolvedValue(JSON.stringify(cachedPolicy));

    const result = await engine.loadPolicy("t1", "costaff");

    expect(result).toEqual(cachedPolicy);
    expect(env.SESSION_CACHE.get).toHaveBeenCalledWith("policy:t1:costaff");
    // Should NOT query DB if cache hit
    expect(WorkflowRepository).not.toHaveBeenCalled();
  });

  it("should query DB when KV cache misses", async () => {
    const dbPolicy = {
      tenantId: "t2",
      product: "controlcenter",
      defaultMode: "review_before_run",
      defaultAppetite: "cautious",
      trustFloor: 0.8,
      enableHumanReview: true,
      sensitiveCategories: ["browser"],
      blockedSkillSlugs: [],
      maxConcurrentWorkflows: 3,
    };

    // KV returns null
    (env.SESSION_CACHE.get as any).mockResolvedValue(null);

    // DB returns a policy
    const mockLoadPolicy = vi.fn().mockResolvedValue(dbPolicy);
    (WorkflowRepository as any).mockImplementation(() => ({
      loadPolicy: mockLoadPolicy,
    }));

    const result = await engine.loadPolicy("t2", "controlcenter");

    expect(result).toEqual(dbPolicy);
    expect(mockLoadPolicy).toHaveBeenCalledWith("t2", "controlcenter");
    // Should cache the result in KV
    expect(env.SESSION_CACHE.put).toHaveBeenCalledWith(
      "policy:t2:controlcenter",
      JSON.stringify(dbPolicy),
      { expirationTtl: 300 },
    );
  });

  it("should fall back to defaultPolicy when both KV and DB miss", async () => {
    (env.SESSION_CACHE.get as any).mockResolvedValue(null);
    (WorkflowRepository as any).mockImplementation(() => ({
      loadPolicy: vi.fn().mockResolvedValue(null),
    }));

    const result = await engine.loadPolicy("t3", "bombastic");

    const expected = defaultPolicy("t3", "bombastic");
    expect(result).toEqual(expected);
  });

  it("should fall back to defaultPolicy when DB throws", async () => {
    (env.SESSION_CACHE.get as any).mockResolvedValue(null);
    (WorkflowRepository as any).mockImplementation(() => ({
      loadPolicy: vi.fn().mockRejectedValue(new Error("DB connection failed")),
    }));

    const result = await engine.loadPolicy("t4", "costaff");

    const expected = defaultPolicy("t4", "costaff");
    expect(result).toEqual(expected);
  });

  it("should fall back gracefully when KV cache is corrupted JSON", async () => {
    (env.SESSION_CACHE.get as any).mockResolvedValue("not-valid-json{{{");
    (WorkflowRepository as any).mockImplementation(() => ({
      loadPolicy: vi.fn().mockResolvedValue(null),
    }));

    const result = await engine.loadPolicy("t5", "bombastic");

    const expected = defaultPolicy("t5", "bombastic");
    expect(result).toEqual(expected);
  });

  it("should not cache when DB returns null (defaultPolicy used)", async () => {
    (env.SESSION_CACHE.get as any).mockResolvedValue(null);
    (WorkflowRepository as any).mockImplementation(() => ({
      loadPolicy: vi.fn().mockResolvedValue(null),
    }));

    await engine.loadPolicy("t6", "costaff");

    // put should NOT be called — only DB results get cached
    expect(env.SESSION_CACHE.put).not.toHaveBeenCalled();
  });
});
