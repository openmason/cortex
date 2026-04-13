import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @daytonaio/sdk before importing engine
const mockDelete = vi.fn().mockResolvedValue(undefined);
const mockCodeRun = vi.fn();
const mockExecuteCommand = vi.fn();
const mockCreate = vi.fn().mockResolvedValue({
  process: { executeCommand: mockExecuteCommand, codeRun: mockCodeRun },
  fs: { uploadFile: vi.fn().mockResolvedValue(undefined) },
  delete: mockDelete,
});
vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn().mockImplementation(() => ({
    create: mockCreate,
  })),
}));

import { WorkflowEngine } from "../../src/workflow/engine";
import type { Env, WorkflowPlan, TenantContext, SkillReference } from "../../src/types";
import type { LLMClient, ChatCompletionResponse } from "../../src/clients/llm";

function makeSkill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    id: "skill-1",
    slug: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    executionLayer: "mcp-remote",
    mcpUrl: "https://mcp.example.com/tools",
    trustScore: 0.85,
    verificationTier: "verified",
    trustBadge: null,
    status: "published",
    skillType: "atomic",
    runCount: 10,
    ...overrides,
  };
}

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: "wf-1",
    mode: "full_auto",
    createdAt: new Date().toISOString(),
    steps: [
      {
        id: "step-1",
        order: 0,
        skill: makeSkill(),
        onError: "fail",
        status: "pending",
      },
    ],
    ...overrides,
  };
}

const makeTenant = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  tenantId: "tenant-1",
  userId: "user-1",
  product: "controlcenter",
  appetite: "balanced",
  executionMode: "full_auto",
  ...overrides,
});

function makeMockEnv(): Env {
  const kvStore = new Map<string, string>();
  return {
    SESSION_CACHE: {} as KVNamespace,
    WORKFLOW_STATE: {
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    } as unknown as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue({ arrayBuffer: () => new ArrayBuffer(0) }),
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
  } as Env;
}

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    engine = new WorkflowEngine(env);

    // Mock fetch for L0 MCP calls and Runics invocations
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { data: "ok" } }),
    }));
  });

  describe("start", () => {
    it("should execute full_auto workflow immediately", async () => {
      const plan = makePlan({ mode: "full_auto" });
      const tenant = makeTenant({ executionMode: "full_auto" });

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("completed");
      expect(state.plan.steps[0].status).toBe("completed");
      expect(state.completedAt).toBeDefined();
    });

    it("should pause review_before_run workflow for approval", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant({ executionMode: "review_before_run" });

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("paused_for_review");
      expect(state.pausedAt).toBeDefined();
    });

    it("should pause step_by_step workflow for approval", async () => {
      const plan = makePlan({ mode: "step_by_step" });
      const tenant = makeTenant({ executionMode: "step_by_step" });

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("paused_for_review");
    });

    it("should block workflow if any skill is revoked", async () => {
      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({ status: "revoked", revokedReason: "CVE-2024-0001" }),
            onError: "fail",
            status: "pending",
          },
        ],
      });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("failed");
      expect(state.error).toContain("revoked");
    });

    it("should block workflow if skill trust is below appetite", async () => {
      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({ trustScore: 0.3 }),
            onError: "fail",
            status: "pending",
          },
        ],
      });
      const tenant = makeTenant({ appetite: "balanced" }); // threshold = 0.50

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("failed");
      expect(state.error).toContain("below appetite threshold");
    });

  });

  describe("resume", () => {
    it("should execute a paused workflow after approval", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const pausedState = await engine.start(plan, tenant, ctx);
      expect(pausedState.status).toBe("paused_for_review");

      const resumedState = await engine.resume(pausedState, true, undefined, ctx);
      expect(resumedState.status).toBe("completed");
    });

    it("should fail workflow if rejected", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const pausedState = await engine.start(plan, tenant, ctx);
      const rejectedState = await engine.resume(pausedState, false);

      expect(rejectedState.status).toBe("failed");
      expect(rejectedState.error).toContain("rejected");
    });

    it("should apply modified plan on resume", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const pausedState = await engine.start(plan, tenant, ctx);

      const modifiedPlan: WorkflowPlan = {
        ...plan,
        steps: [
          ...plan.steps,
          {
            id: "step-2",
            order: 1,
            skill: makeSkill({ id: "skill-2", slug: "added-skill" }),
            onError: "skip",
            status: "pending",
          },
        ],
      };

      const resumedState = await engine.resume(pausedState, true, modifiedPlan, ctx);
      expect(resumedState.status).toBe("completed");
      expect(resumedState.plan.steps.length).toBe(2);
    });
  });

  describe("error handling", () => {
    it("should skip failed step with onError=skip", async () => {
      // First fetch call fails (MCP), second succeeds
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("error") });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({ id: "s1" }),
            onError: "skip",
            status: "pending",
          },
          {
            id: "step-2",
            order: 1,
            skill: makeSkill({ id: "s2" }),
            onError: "fail",
            status: "pending",
          },
        ],
      });

      const state = await engine.start(plan, makeTenant(), ctx);

      expect(state.status).toBe("completed");
      expect(state.plan.steps[0].status).toBe("skipped");
      expect(state.plan.steps[1].status).toBe("completed");
    });

    it("should fail workflow on step failure with onError=fail", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      }));

      const plan = makePlan({ mode: "full_auto" });
      const state = await engine.start(plan, makeTenant(), ctx);

      expect(state.status).toBe("failed");
      expect(state.plan.steps[0].status).toBe("failed");
    });
  });

  describe("step_by_step mode", () => {
    it("should pause after each step for confirmation", async () => {
      const plan = makePlan({
        mode: "step_by_step",
        steps: [
          { id: "s1", order: 0, skill: makeSkill({ id: "s1" }), onError: "fail", status: "pending" },
          { id: "s2", order: 1, skill: makeSkill({ id: "s2" }), onError: "fail", status: "pending" },
        ],
      });

      // First start — pauses for review (before any execution)
      const state1 = await engine.start(plan, makeTenant(), ctx);
      expect(state1.status).toBe("paused_for_review");

      // Resume — executes step 1, then pauses before step 2
      const state2 = await engine.resume(state1, true, undefined, ctx);
      expect(state2.status).toBe("paused_at_step");
      expect(state2.currentStepIndex).toBe(1);

      // Resume — executes step 2. Since step_by_step pauses before each
      // step after the first, step 2 also requires a resume cycle.
      const state3 = await engine.resume(state2, true, undefined, ctx);
      // Step 2 is the last step, so after execution it completes.
      // But the engine pauses BEFORE executing (i > 0 check), so
      // after resuming from paused_at_step=1, it executes step 1 (index 1)
      // and there are no more steps, so it completes.
      expect(state3.status).toBe("completed");
    });
  });

  describe("timeout enforcement", () => {
    it("should set timeoutAt when workflow pauses for review", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);

      expect(state.status).toBe("paused_for_review");
      expect(state.timeoutAt).toBeDefined();
      // timeoutAt should be in the future
      expect(new Date(state.timeoutAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it("should set timeoutAt when workflow pauses at step (step_by_step)", async () => {
      const plan = makePlan({
        mode: "step_by_step",
        steps: [
          { id: "s1", order: 0, skill: makeSkill({ id: "s1" }), onError: "fail", status: "pending" },
          { id: "s2", order: 1, skill: makeSkill({ id: "s2" }), onError: "fail", status: "pending" },
        ],
      });
      const tenant = makeTenant();

      // First start pauses for review (before any execution)
      const state1 = await engine.start(plan, tenant, ctx);
      expect(state1.status).toBe("paused_for_review");
      expect(state1.timeoutAt).toBeDefined();

      // Resume executes step 1, then pauses at step 2
      const state2 = await engine.resume(state1, true, undefined, ctx);
      expect(state2.status).toBe("paused_at_step");
      expect(state2.timeoutAt).toBeDefined();
    });

    it("should return timed_out when resuming an expired workflow", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);
      expect(state.status).toBe("paused_for_review");

      // Simulate expiration by setting timeoutAt to the past
      state.timeoutAt = new Date(Date.now() - 1000).toISOString();

      const resumed = await engine.resume(state, true, undefined, ctx);
      expect(resumed.status).toBe("timed_out");
      expect(resumed.error).toContain("timed out");
      expect(resumed.completedAt).toBeDefined();
    });

    it("should resume normally when state has no timeoutAt (backward compat)", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);
      expect(state.status).toBe("paused_for_review");

      // Remove timeoutAt to simulate old state
      delete state.timeoutAt;

      const resumed = await engine.resume(state, true, undefined, ctx);
      expect(resumed.status).toBe("completed");
    });

    it("should not affect non-paused workflows in checkAndApplyTimeout", async () => {
      const plan = makePlan({ mode: "full_auto" });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);
      expect(state.status).toBe("completed");

      // checkAndApplyTimeout should be a no-op for completed workflows
      const checked = await engine.checkAndApplyTimeout(state);
      expect(checked.status).toBe("completed");
    });
  });

  describe("persistence", () => {
    it("should persist and load workflow state from KV", async () => {
      const plan = makePlan({ mode: "review_before_run" });
      const tenant = makeTenant();

      const state = await engine.start(plan, tenant, ctx);

      // Load from KV
      const loaded = await engine.loadState(state.workflowId);
      expect(loaded).not.toBeNull();
      expect(loaded!.workflowId).toBe(state.workflowId);
      expect(loaded!.status).toBe("paused_for_review");
    });

    it("should return null for non-existent workflow", async () => {
      const loaded = await engine.loadState("nonexistent-id");
      expect(loaded).toBeNull();
    });
  });

  describe("stepUpdate data events", () => {
    it("should emit stepUpdate started and completed data events", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const plan = makePlan({ mode: "full_auto" });
      const tenant = makeTenant({ executionMode: "full_auto" });

      await engine.start(plan, tenant, ctx, undefined, onEvent);

      // Find stepUpdate events
      const stepUpdates = events.filter(
        (e) => e.type === "data" && e.data?.[0]?.type === "stepUpdate",
      );

      expect(stepUpdates).toHaveLength(2); // started + completed
      expect(stepUpdates[0].data[0].status).toBe("started");
      expect(stepUpdates[0].data[0].stepIndex).toBe(0);
      expect(stepUpdates[0].data[0].skillSlug).toBe("test-skill");
      expect(stepUpdates[1].data[0].status).toBe("completed");
      expect(stepUpdates[1].data[0].stepIndex).toBe(0);
    });

    it("should emit stepUpdate failed when step fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      }));

      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const plan = makePlan({ mode: "full_auto" });
      const tenant = makeTenant();

      await engine.start(plan, tenant, ctx, undefined, onEvent);

      const stepUpdates = events.filter(
        (e) => e.type === "data" && e.data?.[0]?.type === "stepUpdate",
      );

      // started + failed
      expect(stepUpdates).toHaveLength(2);
      expect(stepUpdates[0].data[0].status).toBe("started");
      expect(stepUpdates[1].data[0].status).toBe("failed");
    });

    it("should emit stepUpdate events alongside step-start and step-finish", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const plan = makePlan({ mode: "full_auto" });
      const tenant = makeTenant();

      await engine.start(plan, tenant, ctx, undefined, onEvent);

      const types = events.map((e) =>
        e.type === "data" ? `data:${e.data[0].type}` : e.type,
      );

      // Should see: step-start, data:stepUpdate(started), step-finish, data:stepUpdate(completed), data:workflow-complete
      expect(types).toContain("step-start");
      expect(types).toContain("step-finish");
      expect(types).toContain("data:stepUpdate");
      expect(types).toContain("data:workflow-complete");
    });
  });

  describe("codegen fallback via LLM", () => {
    function makeMockLLM(): LLMClient {
      return {
        chat: vi.fn().mockResolvedValue({
          id: "resp-1",
          object: "chat.completion",
          created: Date.now(),
          model: "test-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: 'const input = {};\nconsole.log(JSON.stringify({ result: "generated" }));',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        } as ChatCompletionResponse),
      } as unknown as LLMClient;
    }

    it("should use codegen fallback for skills with no bundle when LLM is provided", async () => {
      const mockLLM = makeMockLLM();
      const engineWithLLM = new WorkflowEngine(env, mockLLM);

      // codeRun returns successful result
      mockCodeRun.mockResolvedValue({
        exitCode: 0,
        result: '{"result":"generated"}',
      });

      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({
              executionLayer: "container",
              mcpUrl: undefined,
              skillMd: undefined,
              r2BundleKey: undefined,
            }),
            onError: "fail",
            status: "pending",
          },
        ],
      });

      const state = await engineWithLLM.start(plan, makeTenant(), ctx);

      expect(state.status).toBe("completed");
      expect(state.plan.steps[0].status).toBe("completed");
      expect(state.plan.steps[0].result?.output).toHaveProperty("codegenerated", true);
      expect(mockLLM.chat).toHaveBeenCalled();
      expect(mockCodeRun).toHaveBeenCalled();
    });

    it("should fail codegen step when no LLM is provided", async () => {
      // Engine without LLM — codegen fallback won't work
      const engineNoLLM = new WorkflowEngine(env);

      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({
              executionLayer: "container",
              mcpUrl: undefined,
              skillMd: undefined,
              r2BundleKey: undefined,
            }),
            onError: "fail",
            status: "pending",
          },
        ],
      });

      // Mock Daytona execute to simulate "bundle not found"
      mockExecuteCommand.mockResolvedValue({
        exitCode: 1,
        result: {
          code: 1,
          output: "Bundle not found",
        },
      });

      const state = await engineNoLLM.start(plan, makeTenant(), ctx);

      expect(state.status).toBe("failed");
      expect(state.plan.steps[0].status).toBe("failed");
    });

    it("should execute multi-step workflow with codegen for mixed skills", async () => {
      const mockLLM = makeMockLLM();
      const engineWithLLM = new WorkflowEngine(env, mockLLM);

      mockCodeRun.mockResolvedValue({
        exitCode: 0,
        result: '{"result":"codegen-output"}',
      });

      // Step 1: MCP skill (uses fetch), Step 2: container skill with no bundle (uses codegen)
      const plan = makePlan({
        mode: "full_auto",
        steps: [
          {
            id: "step-1",
            order: 0,
            skill: makeSkill({ id: "s1", executionLayer: "mcp-remote", mcpUrl: "https://mcp.example.com/tools" }),
            onError: "fail",
            status: "pending",
          },
          {
            id: "step-2",
            order: 1,
            skill: makeSkill({
              id: "s2",
              executionLayer: "container",
              mcpUrl: undefined,
              skillMd: undefined,
              r2BundleKey: undefined,
            }),
            onError: "fail",
            status: "pending",
          },
        ],
      });

      const state = await engineWithLLM.start(plan, makeTenant(), ctx);

      expect(state.status).toBe("completed");
      expect(state.plan.steps[0].status).toBe("completed"); // MCP step
      expect(state.plan.steps[1].status).toBe("completed"); // Codegen step
      expect(state.plan.steps[1].result?.output).toHaveProperty("codegenerated", true);
    });
  });
});
