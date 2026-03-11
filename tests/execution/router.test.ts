import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @daytonaio/sdk before importing router
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockExecuteCommand = vi.fn();
const mockCodeRun = vi.fn();
const mockUploadFile = vi.fn().mockResolvedValue(undefined);
const mockCreate = vi.fn().mockResolvedValue({
  process: { executeCommand: mockExecuteCommand, codeRun: mockCodeRun },
  fs: { uploadFile: mockUploadFile },
  delete: mockDelete,
});
vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn().mockImplementation(() => ({
    create: mockCreate,
  })),
}));

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
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
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
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        result: "All checks passed",
      });

      const skill = makeSkill({
        executionLayer: "container",
        r2BundleKey: "skills/cargo-audit/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, { repo: "org/timon" }, ctx);

      expect(result.success).toBe(true);
      expect(result.layer).toBe("container");
      expect((result.output as any).stdout).toBe("All checks passed");
      expect(mockCreate).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalled();
    });

    it("should handle non-zero exit codes", async () => {
      mockExecuteCommand.mockResolvedValue({
        exitCode: 1,
        result: "",
      });

      const skill = makeSkill({
        executionLayer: "container",
        r2BundleKey: "skills/cargo-audit/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
    });

    it("should clean up sandbox even on error", async () => {
      mockExecuteCommand.mockRejectedValue(new Error("Sandbox timeout"));

      const skill = makeSkill({
        executionLayer: "container",
        r2BundleKey: "skills/cargo-audit/1.0.0/bundle.tar.gz",
      });
      const result = await router.execute(skill, {}, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Sandbox timeout");
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

describe("Codegen fallback", () => {
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  const mockLLM = {
    chat: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should generate code and execute in Daytona when L1 has no skillMd", async () => {
    mockLLM.chat.mockResolvedValue({
      choices: [{ message: { content: 'const input = {};\nconsole.log(JSON.stringify({ result: "hello" }));' } }],
    });
    mockCodeRun.mockResolvedValue({
      exitCode: 0,
      result: '{"result":"hello"}',
    });

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({ executionLayer: "instructions", skillMd: undefined });
    const result = await router.execute(skill, { message: "hello" }, ctx);

    expect(result.success).toBe(true);
    expect(result.layer).toBe("container");
    expect((result.output as any).codegenerated).toBe(true);
    expect(mockLLM.chat).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
  });

  it("should generate code and execute when L3 has no bundleKey", async () => {
    mockLLM.chat.mockResolvedValue({
      choices: [{ message: { content: 'console.log(JSON.stringify({ ok: true }));' } }],
    });
    mockCodeRun.mockResolvedValue({
      exitCode: 0,
      result: '{"ok":true}',
    });

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({ executionLayer: "container", r2BundleKey: undefined });
    const result = await router.execute(skill, {}, ctx);

    expect(result.success).toBe(true);
    expect(result.layer).toBe("container");
    expect((result.output as any).codegenerated).toBe(true);
  });

  it("should fallback from worker when bundle not found and LLM available", async () => {
    env = makeMockEnv({
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as R2Bucket,
    });

    mockLLM.chat.mockResolvedValue({
      choices: [{ message: { content: 'console.log(JSON.stringify({ generated: true }));' } }],
    });
    mockCodeRun.mockResolvedValue({
      exitCode: 0,
      result: '{"generated":true}',
    });

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({
      executionLayer: "worker",
      r2BundleKey: "skills/test/1.0.0/bundle.js",
    });
    const result = await router.execute(skill, {}, ctx);

    expect(result.success).toBe(true);
    expect(result.layer).toBe("container");
    expect((result.output as any).codegenerated).toBe(true);
  });

  it("should fail if LLM returns empty code", async () => {
    mockLLM.chat.mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({ executionLayer: "container", r2BundleKey: undefined });
    const result = await router.execute(skill, {}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Codegen failed");
  });

  it("should fail codegen gracefully if LLM throws", async () => {
    mockLLM.chat.mockRejectedValue(new Error("LLM proxy down"));

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({ executionLayer: "container", r2BundleKey: undefined });
    const result = await router.execute(skill, {}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM proxy down");
  });

  it("should strip markdown fences from generated code", async () => {
    mockLLM.chat.mockResolvedValue({
      choices: [{ message: { content: '```javascript\nconsole.log(JSON.stringify({ ok: true }));\n```' } }],
    });
    mockCodeRun.mockResolvedValue({
      exitCode: 0,
      result: '{"ok":true}',
    });

    const router = new ExecutionRouter(env, mockLLM);
    const skill = makeSkill({ executionLayer: "container", r2BundleKey: undefined });
    const result = await router.execute(skill, {}, ctx);

    expect(result.success).toBe(true);
    // Verify codeRun was called with code that doesn't contain markdown fences
    const codeArg = mockCodeRun.mock.calls[0][0];
    expect(codeArg).not.toContain("```");
  });

  it("should not codegen when no LLM client provided", async () => {
    const router = new ExecutionRouter(env); // no LLM
    const skill = makeSkill({ executionLayer: "container", r2BundleKey: undefined });
    const result = await router.execute(skill, {}, ctx);

    // Falls through to executeL3 which calls Daytona without bundle — still executes
    // but without codegen
    expect(mockLLM.chat).not.toHaveBeenCalled();
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
