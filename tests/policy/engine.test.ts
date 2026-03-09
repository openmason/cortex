import { describe, it, expect, vi } from "vitest";
import { PolicyEngine, defaultPolicy, type TenantPolicy } from "../../src/policy/engine";
import type { Env, SkillReference, WorkflowPlan, TenantContext } from "../../src/types";

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

function makePlan(skills: SkillReference[]): WorkflowPlan {
  return {
    id: "wf-1",
    mode: "full_auto",
    createdAt: new Date().toISOString(),
    steps: skills.map((skill, i) => ({
      id: `step-${i}`,
      order: i,
      skill,
      onError: "fail" as const,
      status: "pending" as const,
    })),
  };
}

const mockEnv = {
  WORKFLOW_STATE: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
  },
} as unknown as Env;

const tenant: TenantContext = {
  tenantId: "t1",
  userId: "u1",
  product: "costaff",
  appetite: "balanced",
  executionMode: "review_before_run",
};

describe("PolicyEngine", () => {
  const engine = new PolicyEngine(mockEnv);

  describe("checkSkill", () => {
    it("should allow skills that pass all checks", () => {
      const policy = defaultPolicy("t1", "costaff");
      const skill = makeSkill({ trustScore: 0.9 });

      const result = engine.checkSkill(skill, policy);
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("should block skills in the blocked list", () => {
      const policy: TenantPolicy = {
        ...defaultPolicy("t1", "costaff"),
        blockedSkillSlugs: ["dangerous-tool"],
      };
      const skill = makeSkill({ slug: "dangerous-tool" });

      const result = engine.checkSkill(skill, policy);
      expect(result.allowed).toBe(false);
      expect(result.violations[0].type).toBe("blocked_skill");
    });

    it("should require review for sensitive categories", () => {
      const policy = defaultPolicy("t1", "costaff");
      // costaff defaults: sensitiveCategories = ["filesystem", "git", "browser", "docker", "binary"]
      const skill = makeSkill({
        trustScore: 0.9,
        capabilitiesRequired: ["filesystem"],
      });

      const result = engine.checkSkill(skill, policy);
      expect(result.allowed).toBe(true);
      expect(result.requiresReview).toBe(true);
      expect(result.violations[0].type).toBe("sensitive_category");
    });

    it("should flag skills below trust floor", () => {
      const policy = defaultPolicy("t1", "costaff"); // trustFloor = 0.7
      const skill = makeSkill({ trustScore: 0.5 });

      const result = engine.checkSkill(skill, policy);
      expect(result.violations.some((v) => v.type === "trust_floor")).toBe(true);
    });
  });

  describe("checkPlan", () => {
    it("should pass a plan with clean skills", async () => {
      const policy = defaultPolicy("t1", "costaff");
      const plan = makePlan([makeSkill({ trustScore: 0.9 })]);

      const result = await engine.checkPlan(plan, tenant, policy);
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("should block plan if any skill is blocked", async () => {
      const policy: TenantPolicy = {
        ...defaultPolicy("t1", "costaff"),
        blockedSkillSlugs: ["bad-skill"],
      };
      const plan = makePlan([
        makeSkill({ slug: "good-skill", trustScore: 0.9 }),
        makeSkill({ slug: "bad-skill", trustScore: 0.9 }),
      ]);

      const result = await engine.checkPlan(plan, tenant, policy);
      expect(result.allowed).toBe(false);
    });

    it("should require review if any skill has sensitive capability", async () => {
      const policy = defaultPolicy("t1", "costaff");
      const plan = makePlan([
        makeSkill({ trustScore: 0.9, capabilitiesRequired: ["git"] }),
      ]);

      const result = await engine.checkPlan(plan, tenant, policy);
      expect(result.allowed).toBe(true);
      expect(result.requiresReview).toBe(true);
    });

    it("should collect violations from all steps", async () => {
      const policy: TenantPolicy = {
        ...defaultPolicy("t1", "costaff"),
        trustFloor: 0.8,
      };
      const plan = makePlan([
        makeSkill({ slug: "s1", trustScore: 0.5 }),
        makeSkill({ slug: "s2", trustScore: 0.6 }),
      ]);

      const result = await engine.checkPlan(plan, tenant, policy);
      expect(result.violations.filter((v) => v.type === "trust_floor")).toHaveLength(2);
    });
  });

  describe("checkConcurrentLimit", () => {
    it("should allow if under limit", async () => {
      const policy = defaultPolicy("t1", "costaff");
      const result = await engine.checkConcurrentLimit("t1", policy);
      expect(result).toBeNull();
    });

    it("should block if at limit", async () => {
      const envAtLimit = {
        WORKFLOW_STATE: {
          get: vi.fn().mockResolvedValue("10"),
          put: vi.fn(),
        },
      } as unknown as Env;
      const limitEngine = new PolicyEngine(envAtLimit);
      const policy = defaultPolicy("t1", "costaff"); // max = 10

      const result = await limitEngine.checkConcurrentLimit("t1", policy);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("concurrent_limit");
    });
  });
});

describe("defaultPolicy", () => {
  it("should set bombastic to full_auto with no sensitive categories", () => {
    const policy = defaultPolicy("t1", "bombastic");
    expect(policy.defaultMode).toBe("full_auto");
    expect(policy.sensitiveCategories).toHaveLength(0);
    expect(policy.enableHumanReview).toBe(false);
  });

  it("should set costaff to cautious with sensitive categories", () => {
    const policy = defaultPolicy("t1", "costaff");
    expect(policy.defaultAppetite).toBe("cautious");
    expect(policy.trustFloor).toBe(0.7);
    expect(policy.sensitiveCategories).toContain("filesystem");
    expect(policy.sensitiveCategories).toContain("git");
    expect(policy.enableHumanReview).toBe(true);
  });

  it("should set controlcenter to balanced with human review", () => {
    const policy = defaultPolicy("t1", "controlcenter");
    expect(policy.defaultAppetite).toBe("balanced");
    expect(policy.enableHumanReview).toBe(true);
  });
});
