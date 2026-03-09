import { describe, it, expect } from "vitest";
import { resolveInputMapping } from "../../src/workflow/input-mapping";
import type { WorkflowStep, SkillReference } from "../../src/types";

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

function makeStep(
  index: number,
  output?: unknown,
): WorkflowStep {
  return {
    id: `step-${index}`,
    order: index,
    skill: makeSkill({ id: `skill-${index}`, slug: `skill-${index}` }),
    onError: "fail",
    status: output !== undefined ? "completed" : "pending",
    result: output !== undefined
      ? { success: true, output, durationMs: 100, layer: "worker" }
      : undefined,
  };
}

describe("resolveInputMapping", () => {
  describe("empty/missing mapping", () => {
    it("should return empty object when mapping is undefined", () => {
      const result = resolveInputMapping(undefined, [], 0);
      expect(result).toEqual({});
    });

    it("should return empty object when mapping is empty", () => {
      const result = resolveInputMapping({}, [], 0);
      expect(result).toEqual({});
    });
  });

  describe("$prev reference", () => {
    it("should resolve $prev to previous step output", () => {
      const steps = [
        makeStep(0, { message: "hello" }),
        makeStep(1),
      ];

      const result = resolveInputMapping(
        { input: "$prev" },
        steps,
        1,
      );

      expect(result.input).toEqual({ message: "hello" });
    });

    it("should resolve $prev.field to a specific field", () => {
      const steps = [
        makeStep(0, { message: "hello", count: 42 }),
        makeStep(1),
      ];

      const result = resolveInputMapping(
        { msg: "$prev.message", num: "$prev.count" },
        steps,
        1,
      );

      expect(result.msg).toBe("hello");
      expect(result.num).toBe(42);
    });

    it("should resolve $prev.nested.path to deeply nested value", () => {
      const steps = [
        makeStep(0, { data: { nested: { value: "deep" } } }),
        makeStep(1),
      ];

      const result = resolveInputMapping(
        { val: "$prev.data.nested.value" },
        steps,
        1,
      );

      expect(result.val).toBe("deep");
    });

    it("should return null when no previous step exists", () => {
      const steps = [makeStep(0)];

      const result = resolveInputMapping(
        { input: "$prev" },
        steps,
        0,
      );

      expect(result.input).toBeNull();
    });

    it("should return null when previous step has no result", () => {
      const steps = [makeStep(0), makeStep(1)];

      const result = resolveInputMapping(
        { input: "$prev" },
        steps,
        1,
      );

      expect(result.input).toBeNull();
    });
  });

  describe("$step.N reference", () => {
    it("should resolve $step.0 to the first step output", () => {
      const steps = [
        makeStep(0, { data: "from-step-0" }),
        makeStep(1, { data: "from-step-1" }),
        makeStep(2),
      ];

      const result = resolveInputMapping(
        { first: "$step.0" },
        steps,
        2,
      );

      expect(result.first).toEqual({ data: "from-step-0" });
    });

    it("should resolve $step.N.field to a specific field", () => {
      const steps = [
        makeStep(0, { url: "https://example.com", token: "abc" }),
        makeStep(1, { status: "ok" }),
        makeStep(2),
      ];

      const result = resolveInputMapping(
        { endpoint: "$step.0.url", result: "$step.1.status" },
        steps,
        2,
      );

      expect(result.endpoint).toBe("https://example.com");
      expect(result.result).toBe("ok");
    });

    it("should return null for out-of-bounds step index", () => {
      const steps = [makeStep(0, { data: "hello" })];

      const result = resolveInputMapping(
        { val: "$step.5" },
        steps,
        0,
      );

      expect(result.val).toBeNull();
    });
  });

  describe("literal values", () => {
    it("should pass through non-reference strings", () => {
      const result = resolveInputMapping(
        { name: "John", action: "process" },
        [],
        0,
      );

      expect(result.name).toBe("John");
      expect(result.action).toBe("process");
    });

    it("should pass through numbers and booleans", () => {
      const result = resolveInputMapping(
        { count: 42, active: true },
        [],
        0,
      );

      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
    });

    it("should return unrecognized $ references as-is", () => {
      const result = resolveInputMapping(
        { val: "$context.key", other: "$unknown" },
        [],
        0,
      );

      expect(result.val).toBe("$context.key");
      expect(result.other).toBe("$unknown");
    });
  });

  describe("nested objects and arrays", () => {
    it("should resolve references inside nested objects", () => {
      const steps = [
        makeStep(0, { id: "abc-123" }),
        makeStep(1),
      ];

      const result = resolveInputMapping(
        { config: { skillId: "$prev.id", mode: "auto" } },
        steps,
        1,
      );

      expect(result.config).toEqual({ skillId: "abc-123", mode: "auto" });
    });

    it("should resolve references inside arrays", () => {
      const steps = [
        makeStep(0, { a: 1 }),
        makeStep(1, { b: 2 }),
        makeStep(2),
      ];

      const result = resolveInputMapping(
        { items: ["$step.0.a", "$step.1.b", "literal"] },
        steps,
        2,
      );

      expect(result.items).toEqual([1, 2, "literal"]);
    });
  });
});
