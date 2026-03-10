import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCompositeTrust, deriveCompositeSchema, slugify } from "../../src/clients/forge";
import type { WorkflowStep, SkillReference } from "../../src/types";

function makeSkill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    id: "skill-1",
    slug: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    executionLayer: "mcp-remote",
    trustScore: 0.85,
    verificationTier: "verified",
    trustBadge: null,
    status: "published",
    skillType: "atomic",
    runCount: 10,
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStep> & { skill?: Partial<SkillReference> } = {}): WorkflowStep {
  const { skill: skillOverrides, ...rest } = overrides;
  return {
    id: crypto.randomUUID(),
    order: 0,
    skill: makeSkill(skillOverrides),
    onError: "fail",
    status: "completed",
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// computeCompositeTrust
// ---------------------------------------------------------------------------

describe("computeCompositeTrust", () => {
  it("should return 0.5 for empty steps", () => {
    expect(computeCompositeTrust([])).toBe(0.5);
  });

  it("should compute min(trust) × 0.9 + 0.05 for single step", () => {
    const steps = [makeStep({ skill: { trustScore: 0.85 } })];
    // 0.85 * 0.9 + 0.05 = 0.815 → rounded to 0.82
    expect(computeCompositeTrust(steps)).toBe(0.82);
  });

  it("should use the minimum trust across multiple steps", () => {
    const steps = [
      makeStep({ skill: { trustScore: 0.95 } }),
      makeStep({ skill: { trustScore: 0.70 } }),
      makeStep({ skill: { trustScore: 0.85 } }),
    ];
    // min = 0.70, 0.70 * 0.9 + 0.05 = 0.68
    expect(computeCompositeTrust(steps)).toBe(0.68);
  });

  it("should clamp to minimum of 0.3", () => {
    const steps = [makeStep({ skill: { trustScore: 0.1 } })];
    // 0.1 * 0.9 + 0.05 = 0.14 → clamped to 0.3
    expect(computeCompositeTrust(steps)).toBe(0.3);
  });

  it("should clamp to maximum of 1.0", () => {
    const steps = [makeStep({ skill: { trustScore: 1.0 } })];
    // 1.0 * 0.9 + 0.05 = 0.95
    expect(computeCompositeTrust(steps)).toBe(0.95);
  });

  it("should handle all perfect trust scores", () => {
    const steps = [
      makeStep({ skill: { trustScore: 1.0 } }),
      makeStep({ skill: { trustScore: 1.0 } }),
    ];
    expect(computeCompositeTrust(steps)).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// deriveCompositeSchema
// ---------------------------------------------------------------------------

describe("deriveCompositeSchema", () => {
  it("should return empty schemas for empty steps", () => {
    const schema = deriveCompositeSchema([]);
    expect(schema.input).toEqual({ type: "object" });
    expect(schema.output).toEqual({ type: "object" });
  });

  it("should use first step's input schema", () => {
    const steps = [
      makeStep({
        skill: {
          schemaJson: {
            input: { type: "object", properties: { code: { type: "string" } } },
            output: { type: "object", properties: { result: { type: "string" } } },
          },
        },
      }),
    ];
    const schema = deriveCompositeSchema(steps);
    expect((schema.input as any).properties.code).toBeDefined();
  });

  it("should use last step's output schema", () => {
    const steps = [
      makeStep({
        skill: {
          schemaJson: { input: { type: "object" }, output: { type: "object", properties: { a: {} } } },
        },
      }),
      makeStep({
        skill: {
          schemaJson: { input: { type: "object" }, output: { type: "object", properties: { final: {} } } },
        },
      }),
    ];
    const schema = deriveCompositeSchema(steps);
    expect((schema.output as any).properties.final).toBeDefined();
    expect((schema.output as any).properties.a).toBeUndefined();
  });

  it("should fall back to generic schema when step has no schemaJson", () => {
    const steps = [makeStep()];
    const schema = deriveCompositeSchema(steps);
    expect(schema.input).toEqual({ type: "object" });
    expect(schema.output).toEqual({ type: "object" });
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("should lowercase and kebab-case", () => {
    expect(slugify("Security Review Pipeline")).toBe("security-review-pipeline");
  });

  it("should strip special characters", () => {
    expect(slugify("Cargo Audit (v2)")).toBe("cargo-audit-v2");
  });

  it("should collapse multiple hyphens", () => {
    expect(slugify("Hello   World")).toBe("hello-world");
  });
});

// ---------------------------------------------------------------------------
// ForgeClient.humanDistill (integration)
// ---------------------------------------------------------------------------

describe("ForgeClient.humanDistill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should publish to Runics with full payload and return enriched response", async () => {
    // Mock LLM for alt-queries
    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCallIndex++;
      if (fetchCallIndex === 1) {
        // LLM alt-query generation
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: "chatcmpl-1",
            choices: [{ message: { content: '["security audit","vulnerability scan","dependency check"]' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }),
        });
      }
      // Runics publish
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "new-skill-123", slug: "security-review" }),
      });
    }));

    const { ForgeClient } = await import("../../src/clients/forge");
    const env = {
      RUNICS_URL: "https://runics.test.local",
      LLMPROXY_URL: "https://llmproxy.test.local",
      LLMPROXY_API_KEY: "test-key",
      LLM_MODEL: "test-model",
    } as any;

    const forge = new ForgeClient(env);
    const result = await forge.humanDistill({
      name: "Security Review",
      description: "Comprehensive security review for Rust projects",
      workflowState: {
        workflowId: "wf-1",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        mode: "full_auto",
        plan: {
          id: "plan-1",
          steps: [
            makeStep({ order: 0, skill: { id: "s1", slug: "cargo-clippy", trustScore: 0.9 } }),
            makeStep({ order: 1, skill: { id: "s2", slug: "cargo-audit", trustScore: 0.85 } }),
          ],
          mode: "full_auto",
          createdAt: new Date().toISOString(),
        },
        currentStepIndex: 2,
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      userId: "u1",
      visibility: "team",
      tags: ["security", "rust"],
      category: "code-quality",
    });

    expect(result.skillId).toBe("new-skill-123");
    expect(result.slug).toBe("security-review");
    expect(result.name).toBe("Security Review");
    expect(result.version).toBe("1.0.0");
    expect(result.trustScore).toBeTypeOf("number");
    expect(result.trustScore).toBeLessThanOrEqual(1.0);
    expect(result.trustScore).toBeGreaterThanOrEqual(0.3);
    expect(result.composedFrom).toHaveLength(2);
    expect(result.composedFrom[0].slug).toBe("cargo-clippy");
    expect(result.visibility).toBe("team");
    expect(result.executionLayer).toBe("composite");
    expect(result.skillType).toBe("human-composite");
    expect(result.trustBadge).toBe("human-verified");
    expect(result.createdAt).toBeDefined();

    // Verify the Runics publish payload
    const fetchCalls = (fetch as any).mock.calls;
    const runicsCall = fetchCalls[1]; // second call is Runics
    const runicsBody = JSON.parse(runicsCall[1].body);

    expect(runicsBody.name).toBe("Security Review");
    expect(runicsBody.slug).toBe("security-review");
    expect(runicsBody.executionLayer).toBe("composite");
    expect(runicsBody.source).toBe("human-distilled");
    expect(runicsBody.skillType).toBe("human-composite");
    expect(runicsBody.trustBadge).toBe("human-verified");
    expect(runicsBody.compositionSkillIds).toEqual(["s1", "s2"]);
    expect(runicsBody.steps).toHaveLength(2);
    expect(runicsBody.steps[0].skillSlug).toBe("cargo-clippy");
    expect(runicsBody.steps[1].stepOrder).toBe(1);
    expect(runicsBody.altQueries).toBeDefined();
    expect(runicsBody.altQueries.length).toBeGreaterThanOrEqual(1);
    expect(runicsBody.trustScore).toBeTypeOf("number");
    expect(runicsBody.schemaJson).toBeDefined();
    expect(runicsBody.tags).toEqual(["security", "rust"]);
    expect(runicsBody.category).toBe("code-quality");
    expect(runicsBody.tenantId).toBe("t1"); // team visibility → tenantId included
  });

  it("should omit tenantId for public visibility", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "new-1", slug: "test" }),
    }));

    const { ForgeClient } = await import("../../src/clients/forge");
    const env = {
      RUNICS_URL: "https://runics.test.local",
      LLMPROXY_URL: "https://llmproxy.test.local",
      LLMPROXY_API_KEY: "test-key",
      LLM_MODEL: "test-model",
    } as any;

    const forge = new ForgeClient(env);
    await forge.humanDistill({
      name: "Public Skill",
      description: "A public skill for everyone to use",
      workflowState: {
        workflowId: "wf-1",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        mode: "full_auto",
        plan: {
          id: "plan-1",
          steps: [makeStep()],
          mode: "full_auto",
          createdAt: new Date().toISOString(),
        },
        currentStepIndex: 1,
        status: "completed",
        startedAt: new Date().toISOString(),
      },
      userId: "u1",
      visibility: "public",
    });

    const fetchCalls = (fetch as any).mock.calls;
    // Last call is to Runics (may be second if LLM call happened first, or first if LLM failed)
    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.tenantId).toBeUndefined();
  });

  it("should throw on Runics publish failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }));

    const { ForgeClient } = await import("../../src/clients/forge");
    const env = {
      RUNICS_URL: "https://runics.test.local",
      LLMPROXY_URL: "https://llmproxy.test.local",
      LLMPROXY_API_KEY: "test-key",
      LLM_MODEL: "test-model",
    } as any;

    const forge = new ForgeClient(env);
    await expect(
      forge.humanDistill({
        name: "Test",
        description: "A test skill description here",
        workflowState: {
          workflowId: "wf-1",
          tenantId: "t1",
          userId: "u1",
          product: "bombastic",
          mode: "full_auto",
          plan: { id: "p1", steps: [makeStep()], mode: "full_auto", createdAt: new Date().toISOString() },
          currentStepIndex: 1,
          status: "completed",
          startedAt: new Date().toISOString(),
        },
        userId: "u1",
        visibility: "team",
      }),
    ).rejects.toThrow("Failed to publish skill to Runics");
  });

  it("should use fallback alt-queries when LLM fails", async () => {
    let fetchCallIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCallIndex++;
      if (fetchCallIndex === 1) {
        // LLM fails
        return Promise.reject(new Error("LLM down"));
      }
      // Runics publish succeeds
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: "new-1", slug: "test" }),
      });
    }));

    const { ForgeClient } = await import("../../src/clients/forge");
    const env = {
      RUNICS_URL: "https://runics.test.local",
      LLMPROXY_URL: "https://llmproxy.test.local",
      LLMPROXY_API_KEY: "test-key",
      LLM_MODEL: "test-model",
    } as any;

    const forge = new ForgeClient(env);
    const result = await forge.humanDistill({
      name: "Fallback Test",
      description: "Testing the fallback alt-query path.",
      workflowState: {
        workflowId: "wf-1",
        tenantId: "t1",
        userId: "u1",
        product: "bombastic",
        mode: "full_auto",
        plan: {
          id: "p1",
          steps: [makeStep({ skill: { name: "Cargo Audit" } })],
          mode: "full_auto",
          createdAt: new Date().toISOString(),
        },
        currentStepIndex: 1,
        status: "completed",
        startedAt: new Date().toISOString(),
      },
      userId: "u1",
      visibility: "team",
    });

    // Should still succeed with fallback queries
    expect(result.skillId).toBe("new-1");

    // Check the Runics payload has fallback alt-queries
    const fetchCalls = (fetch as any).mock.calls;
    const runicsCall = fetchCalls[1];
    const body = JSON.parse(runicsCall[1].body);
    expect(body.altQueries.length).toBeGreaterThanOrEqual(1);
    expect(body.altQueries[0]).toBe("fallback test");
  });
});
