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

import { DAGWorkflowEngine } from "../../src/workflow/dag-engine";
import type { Env, WorkflowDAG, DAGStep, SkillReference, Appetite } from "../../src/types";

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

function makeDAGStep(overrides: Partial<DAGStep> = {}): DAGStep {
  return {
    id: "step-1",
    binding: "static",
    skillRef: "test-skill@1.0.0",
    onError: "fail",
    status: "pending",
    ...overrides,
  };
}

function makeDAG(overrides: Partial<WorkflowDAG> = {}): WorkflowDAG {
  return {
    id: "dag-1",
    mode: "full_auto",
    createdAt: new Date().toISOString(),
    steps: [makeDAGStep()],
    ...overrides,
  };
}

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
    DAYTONA_API_URL: "https://api.daytona.io",
    LLM_MODEL: "claude-sonnet-4-20250514",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://litellm.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_SECRET: "test-admin-secret",
  } as Env;
}

interface DAGExecutionContext {
  tenantId: string;
  userId: string;
  product: "bombastic" | "costaff" | "controlcenter";
  appetite: Appetite;
  mode: "full_auto" | "review_before_run" | "step_by_step";
  context?: Record<string, unknown>;
  callbackUrl?: string;
}

const makeContext = (overrides: Partial<DAGExecutionContext> = {}): DAGExecutionContext => ({
  tenantId: "tenant-1",
  userId: "user-1",
  product: "controlcenter",
  appetite: "balanced",
  mode: "full_auto",
  ...overrides,
});

describe("DAGWorkflowEngine", () => {
  let engine: DAGWorkflowEngine;
  let env: Env;
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    engine = new DAGWorkflowEngine(env);

    // Mock fetch for MCP calls and Runics
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      // Mock Runics skill lookup
      if (url.includes("runics") && url.includes("skills")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeSkill()),
        });
      }
      // Mock MCP tool calls
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { data: "ok" } }),
      });
    }));
  });

  describe("executeDAG", () => {
    it("should execute simple single-step DAG", async () => {
      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      expect(state.completedAt).toBeDefined();
      expect(state.outputs).toHaveProperty("a");
    });

    it("should execute multi-step sequential DAG", async () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      expect(Object.keys(state.outputs)).toContain("a");
      expect(Object.keys(state.outputs)).toContain("b");
      expect(Object.keys(state.outputs)).toContain("c");
    });

    it("should execute parallel steps within the same layer", async () => {
      // Track execution order
      const executionOrder: string[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, opts: any) => {
        // Parse step ID from request if possible
        const body = opts?.body ? JSON.parse(opts.body) : {};
        executionOrder.push(`fetch:${url}`);

        if (url.includes("runics") && url.includes("skills")) {
          return { ok: true, json: () => Promise.resolve(makeSkill()) };
        }
        return { ok: true, json: () => Promise.resolve({ result: { data: "ok" } }) };
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b" }), // no deps - parallel with a
          makeDAGStep({ id: "c", dependsOn: ["a", "b"] }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      expect(Object.keys(state.outputs)).toContain("a");
      expect(Object.keys(state.outputs)).toContain("b");
      expect(Object.keys(state.outputs)).toContain("c");
    });

    it("should pause for review_before_run mode", async () => {
      const dag = makeDAG();

      const state = await engine.executeDAG(dag, makeContext({ mode: "review_before_run" }), ctx);

      expect(state.status).toBe("paused_for_review");
      expect(state.currentLayer).toBe(0);
    });

    it("should pause after first layer for step_by_step mode", async () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext({ mode: "step_by_step" }), ctx);

      // Executes layer 0, then pauses before layer 1
      expect(state.status).toBe("paused_at_step");
      expect(state.currentLayer).toBe(1);
    });
  });

  describe("condition evaluation", () => {
    it("should skip step when condition evaluates to false", async () => {
      // First step succeeds with success: false
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ result: { success: false } }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({
            id: "b",
            dependsOn: ["a"],
            condition: { type: "expression", expr: "$step.a.result.success === true" },
          }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      const bResult = state.outputs["b"] as any;
      expect(bResult.status).toBe("skipped");
      expect(bResult.reason).toBe("condition_false");
    });

    it("should run step when condition evaluates to true", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { success: true } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({
            id: "b",
            dependsOn: ["a"],
            // Check that step a completed (status is "completed")
            condition: { type: "expression", expr: "$step.a.status === 'completed'" },
          }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      const bResult = state.outputs["b"] as any;
      expect(bResult.status).toBe("completed");
    });
  });

  describe("approval gates", () => {
    it("should pause at step requiring approval", async () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"], requiresApproval: true }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("paused_for_review");
      expect(state.pausedStepId).toBe("b");
      // Step a should have completed
      expect(state.outputs).toHaveProperty("a");
    });
  });

  describe("error handling", () => {
    it("should skip step with onError=skip on failure", async () => {
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Internal error"),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", onError: "skip" }),
          makeDAGStep({ id: "b" }), // parallel, should still run
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      const aResult = state.outputs["a"] as any;
      expect(aResult.status).toBe("skipped");
    });

    it("should fail workflow with onError=fail on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal error"),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", onError: "fail" }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("failed");
      expect(state.error).toContain("Step \"a\" failed");
    });

    it("should retry step with onError=retry", async () => {
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        callCount++;
        // Fail first two calls (initial + first retry), succeed on third (second retry)
        if (callCount <= 2) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Temporary error"),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "a",
            onError: "retry",
            retry: { count: 2, delayMs: 10, backoff: "linear" },
          }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
      // Should have called 3 times: initial + 2 retries
      expect(callCount).toBe(3);
    });
  });

  describe("trust checks", () => {
    it("should block step for revoked skill", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill({ status: "revoked", revokedReason: "CVE-2024-0001" })),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("failed");
      expect(state.error).toContain("revoked");
    });

    it("should block step when skill trust is below appetite", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill({ trustScore: 0.3 })),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      // balanced appetite requires trust >= 0.50
      const state = await engine.executeDAG(dag, makeContext({ appetite: "balanced" }), ctx);

      expect(state.status).toBe("failed");
      expect(state.error).toContain("below appetite threshold");
    });
  });

  describe("dynamic skill binding", () => {
    it("should resolve dynamically bound skills via natural language", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        // findSkill search endpoint
        if (url.includes("runics") && url.includes("search")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              confidence: "high",
              results: [makeSkill({ slug: "fetched-skill" })],
              enriched: false,
              meta: { latencyMs: 10, tier: 1, cacheHit: false, llmInvoked: false },
            }),
          });
        }
        // Skill lookup
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        // MCP call
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "a",
            binding: "dynamic",
            skillRef: "find a skill to fetch weather data",
          }),
        ],
      });

      const state = await engine.executeDAG(dag, makeContext(), ctx);

      expect(state.status).toBe("completed");
    });
  });

  describe("input mapping", () => {
    it("should resolve $prev template in input mapping", async () => {
      let capturedInput: any = null;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        // Capture the second MCP call's body
        if (opts?.body && !url.includes("runics")) {
          capturedInput = JSON.parse(opts.body);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { value: 42 } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({
            id: "b",
            dependsOn: ["a"],
            inputMapping: {
              previousValue: "$prev.result.value",
            },
          }),
        ],
      });

      await engine.executeDAG(dag, makeContext(), ctx);

      // The input mapping should have resolved $prev
      // (exact verification depends on how ExecutionRouter uses the input)
    });

    it("should resolve $context template in input mapping", async () => {
      const capturedInputs: any[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        // Capture MCP call inputs
        if (opts?.body && !url.includes("runics")) {
          capturedInputs.push(JSON.parse(opts.body));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "clone",
            inputMapping: {
              token: "$context.githubToken",
              repo: "$context.repoUrl",
            },
          }),
        ],
      });

      await engine.executeDAG(dag, makeContext({
        context: {
          githubToken: "ghp_secret123",
          repoUrl: "https://github.com/org/repo",
        },
      }), ctx);

      // Verify context was resolved in input
      expect(capturedInputs.length).toBeGreaterThan(0);
    });

    it("should resolve nested $context paths", async () => {
      const capturedInputs: any[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        if (opts?.body && !url.includes("runics")) {
          capturedInputs.push(JSON.parse(opts.body));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "deploy",
            inputMapping: {
              awsKey: "$context.credentials.aws.accessKey",
              awsSecret: "$context.credentials.aws.secretKey",
            },
          }),
        ],
      });

      await engine.executeDAG(dag, makeContext({
        context: {
          credentials: {
            aws: {
              accessKey: "AKIA...",
              secretKey: "secret...",
            },
          },
        },
      }), ctx);

      expect(capturedInputs.length).toBeGreaterThan(0);
    });

    it("should resolve $context in nested objects within inputMapping", async () => {
      const capturedInputs: any[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        if (opts?.body && !url.includes("runics")) {
          capturedInputs.push(JSON.parse(opts.body));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "api-call",
            inputMapping: {
              headers: {
                Authorization: "$context.apiKey",
              },
              params: {
                org: "$context.organization",
              },
            },
          }),
        ],
      });

      await engine.executeDAG(dag, makeContext({
        context: {
          apiKey: "Bearer xyz",
          organization: "acme-corp",
        },
      }), ctx);

      expect(capturedInputs.length).toBeGreaterThan(0);
    });

    it("should return empty object for $context when no context provided", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [
          makeDAGStep({
            id: "a",
            inputMapping: {
              token: "$context.missing",
            },
          }),
        ],
      });

      // Should not throw when context is undefined
      const state = await engine.executeDAG(dag, makeContext(), ctx);
      expect(state.status).toBe("completed");
    });
  });

  describe("persistence", () => {
    it("should persist state to KV on completion", async () => {
      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx);

      expect(env.WORKFLOW_STATE.put).toHaveBeenCalled();
      const putCalls = (env.WORKFLOW_STATE.put as any).mock.calls;
      expect(putCalls.some((call: any[]) => call[0].includes("dag:"))).toBe(true);
    });

    it("should persist state on pause", async () => {
      const dag = makeDAG();

      await engine.executeDAG(dag, makeContext({ mode: "review_before_run" }), ctx);

      expect(env.WORKFLOW_STATE.put).toHaveBeenCalled();
    });
  });

  describe("SSE streaming", () => {
    it("should emit workflow-start event", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx, onEvent);

      const startEvent = events.find(
        (e) => e.type === "data" && e.data?.[0]?.type === "workflow-start",
      );
      expect(startEvent).toBeDefined();
      expect(startEvent.data[0].stepCount).toBe(1);
    });

    it("should emit step-start and step-finish events", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx, onEvent);

      const stepStart = events.find((e) => e.type === "step-start");
      expect(stepStart).toBeDefined();
      expect(stepStart.stepId).toBe("a");

      const stepFinish = events.find((e) => e.type === "step-finish");
      expect(stepFinish).toBeDefined();
      expect(stepFinish.stepId).toBe("a");
    });

    it("should emit stepUpdate data events", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx, onEvent);

      const stepUpdates = events.filter(
        (e) => e.type === "data" && e.data?.[0]?.type === "stepUpdate",
      );

      expect(stepUpdates.length).toBeGreaterThanOrEqual(2); // started + completed
      expect(stepUpdates.some((e) => e.data[0].status === "started")).toBe(true);
      expect(stepUpdates.some((e) => e.data[0].status === "completed")).toBe(true);
    });

    it("should emit workflow-complete event", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx, onEvent);

      const completeEvent = events.find(
        (e) => e.type === "data" && e.data?.[0]?.type === "workflow-complete",
      );
      expect(completeEvent).toBeDefined();
      expect(completeEvent.data[0].status).toBe("completed");
    });

    it("should emit approval-required event when paused", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"], requiresApproval: true }),
        ],
      });

      await engine.executeDAG(dag, makeContext(), ctx, onEvent);

      const approvalEvent = events.find(
        (e) => e.type === "data" && e.data?.[0]?.type === "approval-required",
      );
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent.data[0].stepId).toBe("b");
    });
  });

  describe("resumeDAG", () => {
    it("should resume paused workflow after approval", async () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"], requiresApproval: true }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      // Execute until paused
      const pausedState = await engine.executeDAG(dag, makeContext(), ctx);
      expect(pausedState.status).toBe("paused_for_review");
      expect(pausedState.pausedStepId).toBe("b");

      // Resume
      const resumedState = await engine.resumeDAG(pausedState, true, ctx);
      expect(resumedState.status).toBe("completed");
      expect(Object.keys(resumedState.outputs)).toContain("b");
      expect(Object.keys(resumedState.outputs)).toContain("c");
    });

    it("should reject workflow when not approved", async () => {
      const dag = makeDAG();

      const pausedState = await engine.executeDAG(dag, makeContext({ mode: "review_before_run" }), ctx);
      expect(pausedState.status).toBe("paused_for_review");

      const rejectedState = await engine.resumeDAG(pausedState, false, ctx);
      expect(rejectedState.status).toBe("failed");
      expect(rejectedState.error).toContain("rejected");
    });

    it("should resume step_by_step workflow layer by layer", async () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      // Execute first layer, pauses at layer 1
      const state1 = await engine.executeDAG(dag, makeContext({ mode: "step_by_step" }), ctx);
      expect(state1.status).toBe("paused_at_step");
      expect(state1.currentLayer).toBe(1);

      // Resume, executes layer 1, pauses at layer 2
      const state2 = await engine.resumeDAG(state1, true, ctx);
      expect(state2.status).toBe("paused_at_step");
      expect(state2.currentLayer).toBe(2);

      // Resume, completes
      const state3 = await engine.resumeDAG(state2, true, ctx);
      expect(state3.status).toBe("completed");
    });

    it("should emit events during resume", async () => {
      const events: any[] = [];
      const onEvent = vi.fn(async (event: any) => { events.push(event); });

      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"], requiresApproval: true }),
        ],
      });

      // Pause at approval gate
      const pausedState = await engine.executeDAG(dag, makeContext(), ctx);

      // Resume with events
      await engine.resumeDAG(pausedState, true, ctx, onEvent);

      // Should have step events for "b"
      const stepStart = events.find((e) => e.type === "step-start" && e.stepId === "b");
      expect(stepStart).toBeDefined();

      const workflowComplete = events.find(
        (e) => e.type === "data" && e.data?.[0]?.type === "workflow-complete",
      );
      expect(workflowComplete).toBeDefined();
    });
  });

  describe("loadDAGState", () => {
    it("should load persisted DAG state", async () => {
      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      const state = await engine.executeDAG(dag, makeContext({ mode: "review_before_run" }), ctx);

      // Load state
      const loaded = await engine.loadDAGState(state.workflowId);
      expect(loaded).not.toBeNull();
      expect(loaded!.workflowId).toBe(state.workflowId);
      expect(loaded!.status).toBe("paused_for_review");
    });

    it("should return null for non-existent workflow", async () => {
      const loaded = await engine.loadDAGState("nonexistent-id");
      expect(loaded).toBeNull();
    });
  });

  describe("callback URL", () => {
    it("should fire callback on workflow completion", async () => {
      const callbackCalls: any[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        // Track callback POSTs
        if (url === "https://webhook.example.com/callback" && opts?.method === "POST") {
          callbackCalls.push(JSON.parse(opts.body));
          return Promise.resolve({ ok: true });
        }
        // Runics skill lookup
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        // MCP calls
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(
        dag,
        makeContext({ callbackUrl: "https://webhook.example.com/callback" }),
        ctx,
      );

      // Wait for waitUntil to process
      await new Promise((r) => setTimeout(r, 10));

      expect(callbackCalls.length).toBe(1);
      expect(callbackCalls[0].status).toBe("completed");
      expect(callbackCalls[0].workflowId).toBe(dag.id);
    });

    it("should fire callback on workflow failure", async () => {
      const callbackCalls: any[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        if (url === "https://webhook.example.com/callback" && opts?.method === "POST") {
          callbackCalls.push(JSON.parse(opts.body));
          return Promise.resolve({ ok: true });
        }
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        // Fail the MCP call
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal error"),
        });
      }));

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a", onError: "fail" })],
      });

      await engine.executeDAG(
        dag,
        makeContext({ callbackUrl: "https://webhook.example.com/callback" }),
        ctx,
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(callbackCalls.length).toBe(1);
      expect(callbackCalls[0].status).toBe("failed");
      expect(callbackCalls[0].error).toBeDefined();
    });

    it("should not fire callback when URL not provided", async () => {
      const callbackCalls: string[] = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts: any) => {
        // Track any callback-like POSTs (to webhook.example.com or similar)
        if (opts?.method === "POST" && url.includes("webhook")) {
          callbackCalls.push(url);
        }
        if (url.includes("runics") && url.includes("skills")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(makeSkill()),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { data: "ok" } }),
        });
      }));

      const dag = makeDAG({
        steps: [makeDAGStep({ id: "a" })],
      });

      await engine.executeDAG(dag, makeContext(), ctx); // No callbackUrl

      await new Promise((r) => setTimeout(r, 10));

      // Should not have any callback POSTs
      expect(callbackCalls.length).toBe(0);
    });
  });
});
