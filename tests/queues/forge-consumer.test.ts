import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleForgeMessage } from "../../src/queues/forge-consumer";
import type { Env, WorkflowPlan } from "../../src/types";

function makeMockEnv(): Env {
  return {
    SESSION_CACHE: {} as KVNamespace,
    WORKFLOW_STATE: {} as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
    COGNIUM_URL: "https://cognium.test.local",
    DAYTONA_URL: "https://daytona.test.local",
    LLM_MODEL: "cognium/claude-sonnet-latest",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llmproxy.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
  } as Env;
}

function makePlan(): WorkflowPlan {
  return {
    id: "wf-1",
    mode: "full_auto",
    createdAt: new Date().toISOString(),
    steps: [
      {
        id: "step-1",
        order: 0,
        skill: {
          id: "skill-1",
          slug: "fetch-data",
          version: "1.0.0",
          name: "Fetch Data",
          executionLayer: "worker",
          trustScore: 0.9,
          verificationTier: "verified",
          trustBadge: null,
          status: "published",
          skillType: "atomic",
          runCount: 50,
        },
        onError: "fail",
        status: "completed",
      },
      {
        id: "step-2",
        order: 1,
        skill: {
          id: "skill-2",
          slug: "transform-data",
          version: "1.0.0",
          name: "Transform Data",
          executionLayer: "worker",
          trustScore: 0.85,
          verificationTier: "verified",
          trustBadge: null,
          status: "published",
          skillType: "atomic",
          runCount: 30,
        },
        onError: "fail",
        status: "completed",
      },
    ],
  };
}

describe("Forge Queue Consumer", () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  describe("auto-distill", () => {
    it("should skip single-step workflows", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const plan = makePlan();
      plan.steps = [plan.steps[0]];

      await handleForgeMessage(
        {
          type: "auto-distill",
          traceId: "trace-1",
          tenantId: "tenant-1",
          prompt: "Do something",
          plan,
          timestamp: Date.now(),
        },
        env,
      );

      // Should not call LLM or Runics for a single-step workflow
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should skip workflows with incomplete steps", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const plan = makePlan();
      plan.steps[1].status = "failed";

      await handleForgeMessage(
        {
          type: "auto-distill",
          traceId: "trace-1",
          tenantId: "tenant-1",
          prompt: "Do something",
          plan,
          timestamp: Date.now(),
        },
        env,
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should call LLM and publish skill when LLM says to distill", async () => {
      const llmResponse = JSON.stringify({
        shouldDistill: true,
        suggestedName: "Fetch & Transform",
        suggestedSlug: "fetch-and-transform",
        suggestedDescription: "Fetches and transforms data",
        reasoning: "Common ETL pattern",
      });

      const mockFetch = vi.fn()
        // LLM call
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: llmResponse, tool_calls: undefined } }],
            }),
        })
        // Runics publish call
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ skillId: "new-skill-1", slug: "fetch-and-transform" }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await handleForgeMessage(
        {
          type: "auto-distill",
          traceId: "trace-1",
          tenantId: "tenant-1",
          prompt: "Fetch and transform data",
          plan: makePlan(),
          timestamp: Date.now(),
        },
        env,
      );

      // Should have called LLM (chat) and Runics (publish)
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify Runics publish call
      const runicsCall = mockFetch.mock.calls[1];
      expect(runicsCall[0]).toBe("https://runics.test.local/v1/skills");
      const body = JSON.parse(runicsCall[1].body);
      expect(body.name).toBe("Fetch & Transform");
      expect(body.slug).toBe("fetch-and-transform");
      expect(body.executionLayer).toBe("composite");
      expect(body.source).toBe("auto-distilled");
      expect(body.compositionSkillIds).toEqual(["skill-1", "skill-2"]);
    });

    it("should not publish when LLM decides not to distill", async () => {
      const llmResponse = JSON.stringify({
        shouldDistill: false,
        reasoning: "Too specific to be reusable",
      });

      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: llmResponse, tool_calls: undefined } }],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await handleForgeMessage(
        {
          type: "auto-distill",
          traceId: "trace-1",
          tenantId: "tenant-1",
          prompt: "Very specific task",
          plan: makePlan(),
          timestamp: Date.now(),
        },
        env,
      );

      // Only LLM call, no Runics call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("generate", () => {
    it("should generate a skill and publish as draft", async () => {
      const skillDef = JSON.stringify({
        name: "Summarize Text",
        slug: "summarize-text",
        description: "Summarizes input text using an LLM",
        executionLayer: "instructions",
        skillMd: "# Summarize\n\nSummarize the given text.",
        capabilitiesRequired: ["text-generation"],
        schemaJson: { input: { text: "string" }, output: { summary: "string" } },
      });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: skillDef, tool_calls: undefined } }],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ skillId: "gen-skill-1", slug: "summarize-text" }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await handleForgeMessage(
        {
          type: "generate",
          intent: "summarize text",
          capabilities: ["text-generation"],
          timestamp: Date.now(),
        },
        env,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify Runics call includes draft status
      const runicsCall = mockFetch.mock.calls[1];
      const body = JSON.parse(runicsCall[1].body);
      expect(body.name).toBe("Summarize Text");
      expect(body.source).toBe("forge-generated");
      expect(body.skillType).toBe("atomic");
      expect(body.status).toBe("draft");
      expect(body.trustBadge).toBeNull();
    });
  });

  describe("unknown type", () => {
    it("should log warning for unknown message type", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await handleForgeMessage(
        { type: "unknown-type" } as any,
        env,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown message type"),
      );
      warnSpy.mockRestore();
    });
  });
});
