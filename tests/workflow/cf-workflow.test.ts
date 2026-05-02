import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillWorkflow } from "../../src/workflow/cf-workflow";
import type { SkillWorkflowParams } from "../../src/workflow/cf-workflow";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// Mock Daytona SDK
vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({
      id: "sandbox-123",
      process: {
        codeRun: vi.fn().mockResolvedValue({ exitCode: 0, result: "ok" }),
        executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: { stdout: "", stderr: "" } }),
      },
      fs: {
        uploadFile: vi.fn().mockResolvedValue(undefined),
      },
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock env
function makeEnv() {
  return {
    SESSION_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue(null),
    },
    RUNICS_URL: "https://runics.test",
    LLMPROXY_URL: "https://llmproxy.test",
    LLMPROXY_API_KEY: "test-key",
    LLM_MODEL: "test-model",
    DAYTONA_API_KEY: "test-daytona-key",
    DAYTONA_API_URL: "https://daytona.test",
    DAYTONA_TARGET: "us",
  } as any;
}

// Mock WorkflowStep that executes callbacks immediately
function makeStep(): WorkflowStep {
  return {
    do: vi.fn().mockImplementation(async (name: string, configOrCallback: any, maybeCallback?: any) => {
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      return callback();
    }),
    sleep: vi.fn().mockResolvedValue(undefined),
    sleepUntil: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock WorkflowEvent
function makeEvent(params: SkillWorkflowParams): WorkflowEvent<SkillWorkflowParams> {
  return {
    payload: params,
    instanceId: "test-instance-123",
    timestamp: new Date(),
  };
}

describe("SkillWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should be instantiable", () => {
    const env = makeEnv();
    const workflow = new SkillWorkflow({} as any, env);
    expect(workflow).toBeDefined();
  });

  it("should resolve and execute a skill successfully", async () => {
    // Mock fetch for Runics skill lookup and MCP execution
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      // Skill lookup
      if (url.includes("runics") && url.includes("skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "skill-123",
            slug: "test-skill",
            version: "1.0.0",
            name: "Test Skill",
            executionLayer: "mcp-remote",
            mcpUrl: "https://mcp.test/execute",
            trustScore: 0.9,
            verificationTier: "verified",
            trustBadge: null,
            status: "published",
            skillType: "atomic",
            runCount: 100,
          }),
        });
      }
      // MCP execution
      if (url.includes("mcp.test")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            result: { data: "execution result" },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }));

    const env = makeEnv();
    const workflow = new SkillWorkflow({} as any, env);
    const step = makeStep();
    const event = makeEvent({
      skillSlug: "test-skill",
      skillVersion: "1.0.0",
      input: { query: "test input" },
      tenantId: "tenant-123",
      requestId: "req-456",
    });

    const result = await workflow.run(event, step);

    expect(result.success).toBe(true);
    expect(result.skillSlug).toBe("test-skill");
    expect(result.skillId).toBe("skill-123");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.output).toBeDefined();

    // Verify step.do was called twice (resolve + execute)
    expect(step.do).toHaveBeenCalledTimes(2);
    expect(step.do).toHaveBeenNthCalledWith(1, "resolve-skill", expect.any(Object), expect.any(Function));
    expect(step.do).toHaveBeenNthCalledWith(2, "execute-skill", expect.any(Object), expect.any(Function));
  });

  it("should handle skill not found error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("runics") && url.includes("skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(null), // Skill not found
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }));

    const env = makeEnv();
    const workflow = new SkillWorkflow({} as any, env);
    const step = makeStep();
    const event = makeEvent({
      skillSlug: "nonexistent-skill",
      input: {},
      tenantId: "tenant-123",
    });

    await expect(workflow.run(event, step)).rejects.toThrow("Skill not found");
  });

  it("should handle execution failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("runics") && url.includes("skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "skill-123",
            slug: "failing-skill",
            version: "1.0.0",
            name: "Failing Skill",
            executionLayer: "mcp-remote",
            mcpUrl: "https://mcp.test/fail",
            trustScore: 0.9,
            verificationTier: "verified",
            trustBadge: null,
            status: "published",
            skillType: "atomic",
            runCount: 10,
          }),
        });
      }
      // MCP returns error
      if (url.includes("mcp.test")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            error: { message: "Execution failed" },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }));

    const env = makeEnv();
    const workflow = new SkillWorkflow({} as any, env);
    const step = makeStep();
    const event = makeEvent({
      skillSlug: "failing-skill",
      input: {},
      tenantId: "tenant-123",
    });

    const result = await workflow.run(event, step);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should configure retry options correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("runics") && url.includes("skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "skill-123",
            slug: "test-skill",
            version: "1.0.0",
            name: "Test Skill",
            executionLayer: "mcp-remote",
            mcpUrl: "https://mcp.test/execute",
            trustScore: 0.9,
            verificationTier: "verified",
            trustBadge: null,
            status: "published",
            skillType: "atomic",
            runCount: 100,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { data: "ok" } }),
      });
    }));

    const env = makeEnv();
    const workflow = new SkillWorkflow({} as any, env);
    const step = makeStep();
    const event = makeEvent({
      skillSlug: "test-skill",
      input: {},
      tenantId: "tenant-123",
    });

    await workflow.run(event, step);

    // Verify retry configuration was passed to step.do
    const resolveCall = (step.do as any).mock.calls[0];
    expect(resolveCall[1]).toEqual({
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    });

    const executeCall = (step.do as any).mock.calls[1];
    expect(executeCall[1]).toEqual({
      retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
      timeout: "5 minutes",
    });
  });
});
