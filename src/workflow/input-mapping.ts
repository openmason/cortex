import type { WorkflowStep } from "../types";

/**
 * Input Mapping Resolver — resolves dynamic references in step inputs.
 *
 * Supported references:
 *
 *   "$prev"          — output of the immediately previous step
 *   "$prev.field"    — a specific field from the previous step's output
 *   "$step.0"        — output of step at index 0
 *   "$step.0.field"  — a specific field from step 0's output
 *   "$context.key"   — (reserved for future use: workflow-level context)
 *
 * If no inputMapping is provided, returns an empty object.
 * If the referenced step has no result, the value resolves to null.
 */
export function resolveInputMapping(
  mapping: Record<string, unknown> | undefined,
  steps: WorkflowStep[],
  currentIndex: number,
): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) {
    return {};
  }

  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(mapping)) {
    resolved[key] = resolveValue(value, steps, currentIndex);
  }

  return resolved;
}

function resolveValue(
  value: unknown,
  steps: WorkflowStep[],
  currentIndex: number,
): unknown {
  // Only resolve string values that start with $
  if (typeof value !== "string" || !value.startsWith("$")) {
    // If it's an object, resolve recursively
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = resolveValue(v, steps, currentIndex);
      }
      return resolved;
    }
    // If it's an array, resolve each element
    if (Array.isArray(value)) {
      return value.map((v) => resolveValue(v, steps, currentIndex));
    }
    return value;
  }

  // $prev — previous step's output
  if (value === "$prev") {
    return getStepOutput(steps, currentIndex - 1);
  }

  // $prev.field.path — specific field from previous step
  if (value.startsWith("$prev.")) {
    const path = value.slice(6); // Remove "$prev."
    const output = getStepOutput(steps, currentIndex - 1);
    return getNestedValue(output, path);
  }

  // $step.N — specific step's output
  const stepMatch = value.match(/^\$step\.(\d+)$/);
  if (stepMatch) {
    const stepIndex = parseInt(stepMatch[1], 10);
    return getStepOutput(steps, stepIndex);
  }

  // $step.N.field.path — specific field from specific step
  const stepFieldMatch = value.match(/^\$step\.(\d+)\.(.+)$/);
  if (stepFieldMatch) {
    const stepIndex = parseInt(stepFieldMatch[1], 10);
    const path = stepFieldMatch[2];
    const output = getStepOutput(steps, stepIndex);
    return getNestedValue(output, path);
  }

  // Unrecognized reference — return as-is
  return value;
}

function getStepOutput(steps: WorkflowStep[], index: number): unknown {
  if (index < 0 || index >= steps.length) return null;
  return steps[index].result?.output ?? null;
}

function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return null;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }

  return current ?? null;
}
