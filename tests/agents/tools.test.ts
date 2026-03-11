import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolExecutor, getToolsForProduct, TOOL_FIND_SKILL, TOOL_CHECK_POLICY, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL } from "../../src/agents/tools";
import type { Env, TenantContext } from "../../src/types";

function makeMockEnv(): Env {
  return {
    SESSION_CACHE: {} as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
    COGNIUM_URL: "https://cognium.test.local",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "claude-sonnet-4-20250514",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://litellm.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
  } as Env;
}

const makeTenant = (product = "bombastic"): TenantContext => ({
  tenantId: "t1",
  userId: "u1",
  product: product as any,
  appetite: "balanced",
  executionMode: "full_auto",
});

describe("getToolsForProduct", () => {
  it("should return 3 tools for bombastic (no checkPolicy)", () => {
    const tools = getToolsForProduct("bombastic");
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("findSkill");
    expect(names).toContain("buildPlan");
    expect(names).toContain("invokeSkill");
    expect(names).not.toContain("checkPolicy");
  });

  it("should return 4 tools for costaff (includes checkPolicy)", () => {
    const tools = getToolsForProduct("costaff");
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.function.name)).toContain("checkPolicy");
  });

  it("should return 4 tools for controlcenter (includes checkPolicy)", () => {
    const tools = getToolsForProduct("controlcenter");
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.function.name)).toContain("checkPolicy");
  });
});

describe("Tool definitions", () => {
  it("should have valid JSON schema for findSkill", () => {
    expect(TOOL_FIND_SKILL.type).toBe("function");
    expect(TOOL_FIND_SKILL.function.parameters.required).toContain("query");
  });

  it("should have valid JSON schema for checkPolicy", () => {
    expect(TOOL_CHECK_POLICY.function.parameters.required).toContain("skillSlug");
    expect(TOOL_CHECK_POLICY.function.parameters.required).toContain("skillTrustScore");
  });

  it("should have valid JSON schema for buildPlan", () => {
    expect(TOOL_BUILD_PLAN.function.parameters.required).toContain("steps");
    expect(TOOL_BUILD_PLAN.function.parameters.required).toContain("reasoning");
  });

  it("should have valid JSON schema for invokeSkill", () => {
    expect(TOOL_INVOKE_SKILL.function.parameters.required).toContain("skillId");
    expect(TOOL_INVOKE_SKILL.function.parameters.required).toContain("input");
  });
});

describe("ToolExecutor", () => {
  let executor: ToolExecutor;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    executor = new ToolExecutor(env, makeTenant());
  });

  describe("findSkill", () => {
    it("should search Runics and cache discovered skills", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            id: "s1", slug: "lint-tool", version: "1.0.0", name: "Lint",
            executionLayer: "worker", trustScore: 0.9, verificationTier: "verified",
            trustBadge: null, status: "published", skillType: "atomic", runCount: 50,
          }],
          confidence: "high", enriched: false,
          meta: { latencyMs: 30, tier: 1, cacheHit: false, llmInvoked: false },
        }),
      }));

      const result = await executor.execute("findSkill", { query: "lint code" }) as any;

      expect(result.results).toHaveLength(1);
      expect(result.results[0].slug).toBe("lint-tool");
      expect(result.confidence).toBe("high");
      // Skill should be cached
      expect(executor.getDiscoveredSkills().has("s1")).toBe(true);
    });
  });

  describe("checkPolicy", () => {
    it("should return policy check result for costaff", async () => {
      executor = new ToolExecutor(env, makeTenant("costaff"));

      const result = await executor.execute("checkPolicy", {
        skillSlug: "some-skill",
        skillTrustScore: 0.9,
      }) as any;

      expect(result.allowed).toBe(true);
    });

    it("should flag sensitive capabilities", async () => {
      executor = new ToolExecutor(env, makeTenant("costaff"));

      const result = await executor.execute("checkPolicy", {
        skillSlug: "fs-tool",
        skillTrustScore: 0.9,
        capabilitiesRequired: ["filesystem"],
      }) as any;

      expect(result.allowed).toBe(true);
      expect(result.requiresReview).toBe(true);
      expect(result.violations.some((v: any) => v.type === "sensitive_category")).toBe(true);
    });

    it("should block low-trust skills", async () => {
      executor = new ToolExecutor(env, makeTenant("costaff"));

      const result = await executor.execute("checkPolicy", {
        skillSlug: "untrusted",
        skillTrustScore: 0.3,
      }) as any;

      expect(result.violations.some((v: any) => v.type === "trust_floor")).toBe(true);
    });
  });

  describe("buildPlan", () => {
    it("should build a plan from discovered skills", async () => {
      // First discover a skill
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            id: "s1", slug: "audit-tool", version: "1.0.0", name: "Audit",
            executionLayer: "container", trustScore: 0.85, verificationTier: "verified",
            trustBadge: null, status: "published", skillType: "atomic", runCount: 20,
          }],
          confidence: "high", enriched: false,
          meta: { latencyMs: 30, tier: 1, cacheHit: false, llmInvoked: false },
        }),
      }));
      await executor.execute("findSkill", { query: "audit" });

      const result = await executor.execute("buildPlan", {
        steps: [
          { skillId: "s1", skillSlug: "audit-tool", onError: "retry" },
        ],
        reasoning: "Run security audit",
      }) as any;

      expect(result.planId).toBeDefined();
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].skillFound).toBe(true);
      expect(result.steps[0].executionLayer).toBe("container");
      expect(result.allSkillsFound).toBe(true);
    });

    it("should flag missing skills", async () => {
      const result = await executor.execute("buildPlan", {
        steps: [{ skillId: "nonexistent", skillSlug: "missing" }],
        reasoning: "test",
      }) as any;

      expect(result.steps[0].skillFound).toBe(false);
      expect(result.allSkillsFound).toBe(false);
    });
  });

  describe("invokeSkill", () => {
    it("should error if skill not discovered first", async () => {
      const result = await executor.execute("invokeSkill", {
        skillId: "unknown",
        skillSlug: "unknown",
        input: {},
      }) as any;

      expect(result.error).toContain("not found");
      expect(result.error).toContain("findSkill");
    });

    it("should execute a discovered MCP skill", async () => {
      // First discover
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            id: "s1", slug: "mcp-tool", version: "1.0.0", name: "MCP Tool",
            executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com",
            trustScore: 0.9, verificationTier: "verified",
            trustBadge: null, status: "published", skillType: "atomic", runCount: 10,
          }],
          confidence: "high", enriched: false,
          meta: { latencyMs: 30, tier: 1, cacheHit: false, llmInvoked: false },
        }),
      }));
      await executor.execute("findSkill", { query: "mcp" });

      // Now invoke — need to reset fetch for the MCP call
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { data: "success" } }),
      }));

      const result = await executor.execute("invokeSkill", {
        skillId: "s1",
        skillSlug: "mcp-tool",
        input: { repo: "org/app" },
      }) as any;

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ data: "success" });
      expect(result.layer).toBe("mcp-remote");
    });
  });

  describe("unknown tool", () => {
    it("should return error for unknown tool names", async () => {
      const result = await executor.execute("nonexistentTool", {}) as any;
      expect(result.error).toContain("Unknown tool");
    });
  });
});
