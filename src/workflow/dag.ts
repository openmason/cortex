/**
 * DAG Utilities — Functions for working with DAG workflows.
 *
 * Implements the @runics/dag format utilities:
 * - toExecutionLayers(): Convert DAG to parallelizable execution layers
 * - evaluateCondition(): Evaluate step conditions against outputs
 * - resolveInputs(): Resolve template expressions in input mappings
 */

import type { WorkflowDAG, DAGStep, ExecutionLayer, DAGCondition } from "../types";

/**
 * Convert a DAG into execution layers.
 * Each layer contains steps that can run in parallel (no interdependencies).
 * Steps are grouped by dependency depth using Kahn's algorithm.
 */
export function toExecutionLayers(dag: WorkflowDAG): ExecutionLayer[] {
  const steps = dag.steps;
  const stepMap = new Map<string, DAGStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  // Build step map and initialize degree tracking
  for (const step of steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  // Calculate in-degrees and build dependency graph
  for (const step of steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (stepMap.has(depId)) {
          inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
          const deps = dependents.get(depId) || [];
          deps.push(step.id);
          dependents.set(depId, deps);
        }
      }
    }
  }

  // Kahn's algorithm to build layers
  const layers: ExecutionLayer[] = [];
  const processed = new Set<string>();

  while (processed.size < steps.length) {
    // Find all steps with in-degree 0 that haven't been processed
    const layer: string[] = [];
    for (const step of steps) {
      if (!processed.has(step.id) && (inDegree.get(step.id) || 0) === 0) {
        layer.push(step.id);
      }
    }

    if (layer.length === 0) {
      // Cycle detected — shouldn't happen with valid DAG
      throw new Error("Cycle detected in DAG dependencies");
    }

    // Add layer
    layers.push({
      index: layers.length,
      stepIds: layer,
    });

    // Mark as processed and update in-degrees
    for (const stepId of layer) {
      processed.add(stepId);
      for (const depId of dependents.get(stepId) || []) {
        inDegree.set(depId, (inDegree.get(depId) || 0) - 1);
      }
    }
  }

  return layers;
}

/**
 * Evaluate a condition expression against workflow outputs.
 * Returns true if the step should run, false if it should be skipped.
 */
export function evaluateCondition(
  condition: DAGCondition,
  outputs: Record<string, unknown>,
): boolean {
  if (condition.type === "expression") {
    return evaluateSimpleExpression(condition.expr, outputs);
  } else if (condition.type === "jmespath") {
    // JMESPath evaluation — simplified version for now
    // Full JMESPath would require a library like @metrichor/jmespath
    return evaluateSimpleExpression(condition.expr, outputs);
  }
  return true;
}

/**
 * Evaluate simple expressions like:
 * - "$step.0.result.success === true"
 * - "$step.search.result.count > 0"
 * - "$prev.status === 'completed'"
 */
function evaluateSimpleExpression(
  expr: string,
  outputs: Record<string, unknown>,
): boolean {
  try {
    // Replace $step.X references with actual values
    let resolved = expr;

    // $step.N.path or $step.name.path
    resolved = resolved.replace(/\$step\.(\w+)(\.[\w.]+)?/g, (_, stepId, path) => {
      const stepOutput = outputs[stepId];
      if (stepOutput === undefined) return "undefined";
      if (!path) return JSON.stringify(stepOutput);

      // Navigate the path
      const pathParts = path.slice(1).split(".");
      let value: unknown = stepOutput;
      for (const part of pathParts) {
        if (value === null || value === undefined) return "undefined";
        value = (value as Record<string, unknown>)[part];
      }
      return JSON.stringify(value);
    });

    // $prev references (last step output)
    resolved = resolved.replace(/\$prev(\.[\w.]+)?/g, (_, path) => {
      const keys = Object.keys(outputs);
      if (keys.length === 0) return "undefined";
      const lastKey = keys[keys.length - 1];
      const prevOutput = outputs[lastKey];
      if (!path) return JSON.stringify(prevOutput);

      const pathParts = path.slice(1).split(".");
      let value: unknown = prevOutput;
      for (const part of pathParts) {
        if (value === null || value === undefined) return "undefined";
        value = (value as Record<string, unknown>)[part];
      }
      return JSON.stringify(value);
    });

    // Evaluate the expression safely
    // Note: This is a simplified evaluator — production would use a proper expression parser
    // We only support simple comparisons: ===, !==, >, <, >=, <=, &&, ||
    const safeEval = new Function("return " + resolved);
    return Boolean(safeEval());
  } catch {
    // On error, default to running the step
    return true;
  }
}

/**
 * Validate a DAG for correctness.
 * Checks for:
 * - Duplicate step IDs
 * - Missing dependencies
 * - Cycles
 */
export function validateDAG(dag: WorkflowDAG): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const stepIds = new Set<string>();

  // Check for duplicate IDs
  for (const step of dag.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);
  }

  // Check for missing dependencies
  for (const step of dag.steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!stepIds.has(depId)) {
          errors.push(`Step "${step.id}" depends on non-existent step "${depId}"`);
        }
      }
    }
  }

  // Check for cycles by attempting to build layers
  if (errors.length === 0) {
    try {
      toExecutionLayers(dag);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Cycle detected in DAG");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert a legacy WorkflowPlan to a WorkflowDAG.
 * Useful for backward compatibility.
 */
export function planToDAG(plan: { id: string; steps: Array<{ id: string; skill: unknown; inputMapping?: unknown; condition?: unknown; onError: string }>; mode: string; createdAt: string }): WorkflowDAG {
  return {
    id: plan.id,
    mode: plan.mode as WorkflowDAG["mode"],
    createdAt: plan.createdAt,
    steps: plan.steps.map((step, index) => ({
      id: step.id,
      binding: "static" as const,
      skillRef: (step.skill as { slug?: string; version?: string })?.slug
        ? `${(step.skill as { slug: string }).slug}@${(step.skill as { version?: string }).version || "latest"}`
        : "unknown",
      skill: step.skill as DAGStep["skill"],
      inputMapping: step.inputMapping as DAGStep["inputMapping"],
      condition: step.condition ? { type: "expression" as const, expr: JSON.stringify(step.condition) } : undefined,
      onError: step.onError as DAGStep["onError"],
      dependsOn: index > 0 ? [plan.steps[index - 1].id] : undefined,
      status: "pending" as const,
    })),
  };
}

/**
 * Convert a WorkflowDAG to legacy WorkflowPlan format.
 * Flattens parallel execution into sequential order.
 */
export function dagToPlan(dag: WorkflowDAG): { id: string; steps: unknown[]; mode: string; createdAt: string } {
  const layers = toExecutionLayers(dag);
  const orderedSteps: unknown[] = [];
  let order = 0;

  for (const layer of layers) {
    for (const stepId of layer.stepIds) {
      const step = dag.steps.find((s) => s.id === stepId);
      if (step) {
        orderedSteps.push({
          id: step.id,
          order: order++,
          skill: step.skill,
          inputMapping: step.inputMapping,
          condition: step.condition,
          onError: step.onError,
          status: step.status,
          result: step.result,
        });
      }
    }
  }

  return {
    id: dag.id,
    steps: orderedSteps,
    mode: dag.mode,
    createdAt: dag.createdAt,
  };
}
