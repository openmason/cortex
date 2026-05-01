import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toExecutionLayers,
  evaluateCondition,
  validateDAG,
  planToDAG,
  dagToPlan,
} from "../../src/workflow/dag";
import type { WorkflowDAG, DAGStep, DAGCondition, WorkflowPlan } from "../../src/types";

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

describe("DAG Utilities", () => {
  describe("toExecutionLayers", () => {
    it("should create single layer for steps with no dependencies", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b" }),
          makeDAGStep({ id: "c" }),
        ],
      });

      const layers = toExecutionLayers(dag);

      expect(layers).toHaveLength(1);
      expect(layers[0].index).toBe(0);
      expect(layers[0].stepIds).toContain("a");
      expect(layers[0].stepIds).toContain("b");
      expect(layers[0].stepIds).toContain("c");
    });

    it("should create multiple layers for sequential dependencies", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      const layers = toExecutionLayers(dag);

      expect(layers).toHaveLength(3);
      expect(layers[0].stepIds).toEqual(["a"]);
      expect(layers[1].stepIds).toEqual(["b"]);
      expect(layers[2].stepIds).toEqual(["c"]);
    });

    it("should parallelize steps with same dependencies", () => {
      // Diamond pattern: a -> (b, c) -> d
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
          makeDAGStep({ id: "c", dependsOn: ["a"] }),
          makeDAGStep({ id: "d", dependsOn: ["b", "c"] }),
        ],
      });

      const layers = toExecutionLayers(dag);

      expect(layers).toHaveLength(3);
      expect(layers[0].stepIds).toEqual(["a"]);
      expect(layers[1].stepIds).toContain("b");
      expect(layers[1].stepIds).toContain("c");
      expect(layers[2].stepIds).toEqual(["d"]);
    });

    it("should handle complex DAG with multiple entry points", () => {
      // a -> c, b -> c, b -> d
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b" }),
          makeDAGStep({ id: "c", dependsOn: ["a", "b"] }),
          makeDAGStep({ id: "d", dependsOn: ["b"] }),
        ],
      });

      const layers = toExecutionLayers(dag);

      expect(layers).toHaveLength(2);
      expect(layers[0].stepIds).toContain("a");
      expect(layers[0].stepIds).toContain("b");
      expect(layers[1].stepIds).toContain("c");
      expect(layers[1].stepIds).toContain("d");
    });

    it("should throw error for cyclic dependencies", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", dependsOn: ["c"] }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
          makeDAGStep({ id: "c", dependsOn: ["b"] }),
        ],
      });

      expect(() => toExecutionLayers(dag)).toThrow("Cycle detected");
    });

    it("should ignore dependencies on non-existent steps", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", dependsOn: ["nonexistent"] }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
        ],
      });

      const layers = toExecutionLayers(dag);

      expect(layers).toHaveLength(2);
      expect(layers[0].stepIds).toEqual(["a"]);
      expect(layers[1].stepIds).toEqual(["b"]);
    });
  });

  describe("evaluateCondition", () => {
    it("should evaluate simple $prev expression", () => {
      const outputs = { step1: { success: true } };
      const condition: DAGCondition = { type: "expression", expr: "$prev.success === true" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(true);
    });

    it("should evaluate $step reference", () => {
      const outputs = {
        search: { result: { count: 5 } },
        transform: { data: [] },
      };
      const condition: DAGCondition = { type: "expression", expr: "$step.search.result.count > 0" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(true);
    });

    it("should return false when condition evaluates to false", () => {
      const outputs = { step1: { success: false } };
      const condition: DAGCondition = { type: "expression", expr: "$prev.success === true" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(false);
    });

    it("should return false when $prev references undefined", () => {
      // When $prev is undefined, the expression evaluates to false
      const outputs = {};
      const condition: DAGCondition = { type: "expression", expr: "$prev.success === true" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(false); // undefined !== true
    });

    it("should evaluate !== operator", () => {
      const outputs = { step1: { status: "completed" } };
      const condition: DAGCondition = { type: "expression", expr: "$prev.status !== 'failed'" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(true);
    });

    it("should evaluate numeric comparisons", () => {
      const outputs = { step1: { count: 10 } };
      const condition: DAGCondition = { type: "expression", expr: "$prev.count >= 5" };

      const result = evaluateCondition(condition, outputs);
      expect(result).toBe(true);
    });
  });

  describe("validateDAG", () => {
    it("should pass validation for valid DAG", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
        ],
      });

      const result = validateDAG(dag);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should detect duplicate step IDs", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "a" }), // duplicate
        ],
      });

      const result = validateDAG(dag);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Duplicate step ID: a");
    });

    it("should detect missing dependencies", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", dependsOn: ["nonexistent"] }),
        ],
      });

      const result = validateDAG(dag);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("non-existent step");
    });

    it("should detect cycles", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a", dependsOn: ["b"] }),
          makeDAGStep({ id: "b", dependsOn: ["a"] }),
        ],
      });

      const result = validateDAG(dag);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Cycle");
    });
  });

  describe("planToDAG", () => {
    it("should convert legacy plan to DAG format", () => {
      const plan = {
        id: "plan-1",
        mode: "full_auto",
        createdAt: new Date().toISOString(),
        steps: [
          { id: "s1", skill: { slug: "fetch", version: "1.0" }, onError: "fail" },
          { id: "s2", skill: { slug: "transform" }, onError: "skip" },
        ],
      };

      const dag = planToDAG(plan);

      expect(dag.id).toBe("plan-1");
      expect(dag.steps).toHaveLength(2);
      expect(dag.steps[0].id).toBe("s1");
      expect(dag.steps[0].binding).toBe("static");
      expect(dag.steps[0].skillRef).toBe("fetch@1.0");
      expect(dag.steps[0].dependsOn).toBeUndefined(); // first step
      expect(dag.steps[1].dependsOn).toEqual(["s1"]); // sequential
      expect(dag.steps[1].skillRef).toBe("transform@latest");
    });
  });

  describe("dagToPlan", () => {
    it("should convert DAG to legacy plan format", () => {
      const dag = makeDAG({
        id: "dag-1",
        steps: [
          makeDAGStep({ id: "a", skill: { id: "sk1", slug: "fetch" } as any }),
          makeDAGStep({ id: "b", dependsOn: ["a"], skill: { id: "sk2", slug: "transform" } as any }),
        ],
      });

      const plan = dagToPlan(dag);

      expect(plan.id).toBe("dag-1");
      expect(plan.steps).toHaveLength(2);
      // Steps should be ordered by layer
      expect((plan.steps[0] as any).order).toBe(0);
      expect((plan.steps[1] as any).order).toBe(1);
    });

    it("should flatten parallel steps into sequential order", () => {
      const dag = makeDAG({
        steps: [
          makeDAGStep({ id: "a" }),
          makeDAGStep({ id: "b" }), // parallel with a
          makeDAGStep({ id: "c", dependsOn: ["a", "b"] }),
        ],
      });

      const plan = dagToPlan(dag);

      expect(plan.steps).toHaveLength(3);
      // a and b are in layer 0, c is in layer 1
      // Order depends on iteration order, but c should be last
      const orders = plan.steps.map((s: any) => s.order);
      expect(orders).toContain(0);
      expect(orders).toContain(1);
      expect(orders).toContain(2);
    });
  });
});
