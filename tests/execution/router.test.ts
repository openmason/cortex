import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionRouter, resolveExecutionLayer } from "../../src/execution/router";
import type { Env, SkillReference } from "../../src/types";

function makeSkill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    id: "skill-1",
    slug: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    executionLayer: "worker",
    trustScore: 0.85,
    verificationTier: "verified",
    trustBadge: null,
    status: "published",
    skillType: "atomic",
    runCount: 10,
    ...overrides,
  };
}

function makeMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_CACHE: {} as KVNamespace,
    WORKFLOW_STATE: {} as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue({ arrayBuffer: () => new ArrayBuffer(0) }),
      put: vi.fn(),
    } as unknown as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
    COGNIUM_URL: "https://circle.cognium.net",
    DAYTONA_URL: "https://api.daytona.io",
    LLM_MODEL: "claude-sonnet-4-20250514",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://litellm.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ...overrides,
  } as Env;
}

describe("ExecutionRouter", () => {
  let router: ExecutionRouter;
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    router = new ExecutionRouter(env);
  });

  describe("L0: MCP Remote", () => {
    it("should call the MCP server via JSON-RPC", async () => {
      const mockResponse = {
        ok: true,
        json: () => Promise.resolve({ result: { data: "license check passed" } }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const skill = makeSkill({
        executionLayer: "mcp-remote",
        mcpUrl: "https://mcp.example.com/tools",
      });

      const result = await router.execute(skill, { repo: "org/timon" }, ctx);

      expect(result.success).toBe(true);
      expect(result.layer).toBe("mcp-remote");
      expect(result.output).toEqual({ data: "license check passed" });
      expect(fetch).toHaveBeenCalledWith("https://mcp.example.com/tools", expect.objectContaining({
        method: "POST",
      }));
    });

    it("should fail if mcpUrl is missing", async () => {
      const skill = makeSkill({ executionLayer: "mcp-remote", mcpUrl: undefined });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing mcpUrl");
    });

    it("should handle MCP server errors", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }));

      const skill = makeSkill({
        executionLayer: "mcp-remote",
        mcpUrl: "https://mcp.example.com/tools",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("500");
    });

    it("should handle JSON-RPC error responses", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: { message: "Tool not found" } }),
      }));

      const skill = makeSkill({
        executionLayer: "mcp-remote",
        mcpUrl: "https://mcp.example.com/tools",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool not found");
    });
  });

  describe("L1: Instructions", () => {
    it("should return skillMd for the supervisor to follow", async () => {
      const skill = makeSkill({
        executionLayer: "instructions",
        skillMd: "# Run cargo clippy\nExecute `cargo clippy` in the project root.",
      });

      const result = await router.execute(skill, { path: "/repo" }, ctx);

      expect(result.success).toBe(true);
      expect(result.layer).toBe("instructions");
      expect((result.output as any).type).toBe("instructions");
      expect((result.output as any).skillMd).toContain("cargo clippy");
    });

    it("should fail if skillMd is missing", async () => {
      const skill = makeSkill({ executionLayer: "instructions", skillMd: undefined });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing skillMd");
    });
  });

  describe("L2: Worker", () => {
    it("should dispatch worker execution with bundle from R2", async () => {
      // Provide a valid JS bundle that exports execute
      const bundleSource = `exports.execute = async function(input) { return { doubled: input.data.map(x => x * 2) }; };`;
      env = makeMockEnv({
        R2_BUCKET: {
          get: vi.fn().mockResolvedValue({
            text: () => Promise.resolve(bundleSource),
            arrayBuffer: () => new ArrayBuffer(0),
          }),
        } as unknown as R2Bucket,
      });
      router = new ExecutionRouter(env);

      const skill = makeSkill({
        executionLayer: "worker",
        r2BundleKey: "skills/json-transform/1.0.0/bundle.js",
      });

      const result = await router.execute(skill, { data: [1, 2, 3] }, ctx);

      expect(result.success).toBe(true);
      expect(result.layer).toBe("worker");
      expect((result.output as any).doubled).toEqual([2, 4, 6]);
    });

    it("should fail if R2 bundle not found", async () => {
      env = makeMockEnv({
        R2_BUCKET: {
          get: vi.fn().mockResolvedValue(null),
        } as unknown as R2Bucket,
      });
      router = new ExecutionRouter(env);

      const skill = makeSkill({
        executionLayer: "worker",
        r2BundleKey: "skills/missing/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Bundle not found");
    });

    it("should fail if r2BundleKey is missing", async () => {
      const skill = makeSkill({ executionLayer: "worker", r2BundleKey: undefined });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing r2BundleKey");
    });
  });

  describe("L3: Container", () => {
    it("should call Daytona sandbox and return result", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          exitCode: 0,
          stdout: "All checks passed",
          stderr: "",
        }),
      }));

      const skill = makeSkill({
        executionLayer: "container",
        r2BundleKey: "skills/cargo-audit/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, { repo: "org/timon" }, ctx);

      expect(result.success).toBe(true);
      expect(result.layer).toBe("container");
      expect((result.output as any).stdout).toBe("All checks passed");
    });

    it("should handle non-zero exit codes", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "2 vulnerabilities found",
        }),
      }));

      const skill = makeSkill({
        executionLayer: "container",
        r2BundleKey: "skills/cargo-audit/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("2 vulnerabilities found");
    });
  });

  describe("Composite", () => {
    it("should reject composite skills (must be expanded first)", async () => {
      const skill = makeSkill({ executionLayer: "composite" });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("expanded by the supervisor");
    });
  });

  describe("Unknown layer", () => {
    it("should fail gracefully for unknown execution layers", async () => {
      const skill = makeSkill({ executionLayer: "quantum" as any });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown execution layer");
    });
  });
});

describe("resolveExecutionLayer", () => {
  it("should return explicit layer if set", () => {
    expect(resolveExecutionLayer({ executionLayer: "container" })).toBe("container");
  });

  it("should resolve mcp-remote for skills with mcpUrl", () => {
    expect(resolveExecutionLayer({ mcpUrl: "https://mcp.example.com" })).toBe("mcp-remote");
  });

  it("should resolve container for skills needing filesystem/git", () => {
    expect(resolveExecutionLayer({ capabilitiesRequired: ["git"] })).toBe("container");
    expect(resolveExecutionLayer({ capabilitiesRequired: ["filesystem"] })).toBe("container");
    expect(resolveExecutionLayer({ capabilitiesRequired: ["browser"] })).toBe("container");
  });

  it("should resolve instructions for skills with only skillMd", () => {
    expect(resolveExecutionLayer({ skillMd: "# Do something" })).toBe("instructions");
  });

  it("should default to worker", () => {
    expect(resolveExecutionLayer({})).toBe("worker");
  });
});
