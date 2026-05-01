/**
 * DAGWorkflowEngine — Executes DAG-based workflows with parallel layers.
 *
 * Features:
 * - Parallel execution of steps with no interdependencies
 * - Static and dynamic skill binding
 * - Condition evaluation for conditional steps
 * - Approval gates (pauses workflow for human review)
 * - Retry policies per step
 */

import type {
  Env,
  WorkflowDAG,
  DAGStep,
  ExecutionLayer,
  TenantContext,
  SkillReference,
  ExecutionResult,
  WorkflowStatus,
  Appetite,
  ExecutionMode,
  OnStreamEvent,
} from "../types";
import { toExecutionLayers, evaluateCondition } from "./dag";
import { ExecutionRouter } from "../execution/router";
import { RunicsClient } from "../clients/runics";
import { CogniumClient } from "../clients/cognium";
import { LLMClient } from "../clients/llm";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

export interface DAGExecutionState {
  workflowId: string;
  tenantId: string;
  userId: string;
  product: string;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  outputs: Record<string, unknown>;
  error?: string;
  currentLayer?: number;
  pausedStepId?: string;
  /** The DAG definition (stored for resume support) */
  dag?: WorkflowDAG;
  /** Execution context (stored for resume support) */
  context?: DAGExecutionContext;
}

export interface DAGExecutionContext {
  tenantId: string;
  userId: string;
  product: "bombastic" | "costaff" | "controlcenter";
  appetite: Appetite;
  mode: ExecutionMode;
  /** Workflow-level context (secrets, shared variables) */
  context?: Record<string, unknown>;
  /** URL to POST final state when workflow completes */
  callbackUrl?: string;
}

export class DAGWorkflowEngine {
  private executor: ExecutionRouter;
  private runics: RunicsClient;
  private cognium: CogniumClient;
  private llm: LLMClient;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(private env: Env, log?: Logger, metrics?: Metrics) {
    this.llm = new LLMClient(env, log);
    this.executor = new ExecutionRouter(env, this.llm, log, metrics);
    this.runics = new RunicsClient(env);
    this.cognium = new CogniumClient();
    this.log = log;
    this.metrics = metrics;
  }

  /**
   * Execute a DAG workflow.
   * Returns the final state after execution (or pause for approval).
   */
  async executeDAG(
    dag: WorkflowDAG,
    context: DAGExecutionContext,
    executionCtx: ExecutionContext,
    onEvent?: OnStreamEvent,
  ): Promise<DAGExecutionState> {
    const state: DAGExecutionState = {
      workflowId: dag.id,
      tenantId: context.tenantId,
      userId: context.userId,
      product: context.product,
      status: "running",
      startedAt: new Date().toISOString(),
      outputs: {},
      dag,
      context,
    };

    this.log?.info("Starting DAG execution", {
      workflowId: dag.id,
      stepCount: dag.steps.length,
      mode: context.mode,
    });

    // Emit workflow start event
    await onEvent?.({
      type: "data",
      data: [{
        type: "workflow-start",
        workflowId: dag.id,
        stepCount: dag.steps.length,
        mode: context.mode,
      }],
    });

    try {
      // Convert DAG to execution layers
      const layers = toExecutionLayers(dag);
      this.log?.debug("DAG converted to layers", {
        workflowId: dag.id,
        layerCount: layers.length,
        layers: layers.map((l) => ({ index: l.index, steps: l.stepIds })),
      });

      // Check if review is required before execution
      if (context.mode === "review_before_run") {
        state.status = "paused_for_review";
        state.currentLayer = 0;
        await this.persistState(state);

        await onEvent?.({
          type: "data",
          data: [{ type: "approval-required", workflowId: dag.id, reason: "review_before_run" }],
        });

        return state;
      }

      // Execute layers sequentially, steps within each layer in parallel
      for (const layer of layers) {
        state.currentLayer = layer.index;

        // Check for step-by-step mode pause
        if (context.mode === "step_by_step" && layer.index > 0) {
          state.status = "paused_at_step";
          await this.persistState(state);

          await onEvent?.({
            type: "data",
            data: [{ type: "approval-required", workflowId: dag.id, layer: layer.index, reason: "step_by_step" }],
          });

          return state;
        }

        // Execute all steps in this layer in parallel
        const layerResults = await this.executeLayer(
          dag,
          layer,
          state.outputs,
          context,
          executionCtx,
          onEvent,
        );

        // Check for failures or pauses
        for (const [stepId, result] of Object.entries(layerResults)) {
          if (result.status === "paused") {
            state.status = "paused_for_review";
            state.pausedStepId = stepId;
            await this.persistState(state);

            await onEvent?.({
              type: "data",
              data: [{ type: "approval-required", workflowId: dag.id, stepId, reason: "approval_gate" }],
            });

            return state;
          }
          if (result.status === "failed" && result.failWorkflow) {
            state.status = "failed";
            state.error = `Step "${stepId}" failed: ${result.error}`;
            state.completedAt = new Date().toISOString();
            await this.persistState(state);

            await onEvent?.({
              type: "error",
              errorText: state.error,
            });

            // Fire callback for failed workflow
            this.fireCallback(state, context, executionCtx);

            return state;
          }
        }

        // Merge layer results into outputs
        Object.assign(state.outputs, layerResults);
      }

      // Workflow completed successfully
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      this.log?.info("DAG execution completed", {
        workflowId: dag.id,
        durationMs: Date.now() - new Date(state.startedAt).getTime(),
      });

      this.metrics?.write("workflow", {
        tenantId: context.tenantId,
        product: context.product,
        status: "ok",
        durationMs: Date.now() - new Date(state.startedAt).getTime(),
      });

      await onEvent?.({
        type: "data",
        data: [{ type: "workflow-complete", workflowId: dag.id, status: state.status }],
      });

      // Fire callback for completed workflow
      this.fireCallback(state, context, executionCtx);

      return state;
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      this.log?.error("DAG execution failed", {
        workflowId: dag.id,
        error: state.error,
      });

      await onEvent?.({
        type: "error",
        errorText: state.error,
      });

      // Fire callback for failed workflow
      this.fireCallback(state, context, executionCtx);

      return state;
    }
  }

  /**
   * Execute a single layer (parallel execution of all steps in the layer).
   */
  private async executeLayer(
    dag: WorkflowDAG,
    layer: ExecutionLayer,
    outputs: Record<string, unknown>,
    context: DAGExecutionContext,
    executionCtx: ExecutionContext,
    onEvent?: OnStreamEvent,
  ): Promise<Record<string, LayerStepResult>> {
    const results: Record<string, LayerStepResult> = {};

    // Execute all steps in parallel
    await Promise.all(
      layer.stepIds.map(async (stepId) => {
        const step = dag.steps.find((s) => s.id === stepId);
        if (!step) {
          results[stepId] = { status: "failed", error: "Step not found", failWorkflow: true };
          return;
        }

        const result = await this.executeStep(step, outputs, context, executionCtx, onEvent);
        results[stepId] = result;
      }),
    );

    return results;
  }

  /**
   * Execute a single DAG step.
   */
  private async executeStep(
    step: DAGStep,
    outputs: Record<string, unknown>,
    context: DAGExecutionContext,
    executionCtx: ExecutionContext,
    onEvent?: OnStreamEvent,
  ): Promise<LayerStepResult> {
    this.log?.debug("Executing step", { stepId: step.id, binding: step.binding, skillRef: step.skillRef });

    // Check condition
    if (step.condition) {
      const shouldRun = evaluateCondition(step.condition, outputs);
      if (!shouldRun) {
        this.log?.debug("Step skipped due to condition", { stepId: step.id });

        await onEvent?.({
          type: "data",
          data: [{ type: "stepUpdate", stepId: step.id, status: "skipped", reason: "condition_false" }],
        });

        return { status: "skipped", reason: "condition_false" };
      }
    }

    // Check approval gate
    if (step.requiresApproval) {
      await onEvent?.({
        type: "data",
        data: [{ type: "stepUpdate", stepId: step.id, status: "paused", reason: "approval_required" }],
      });

      return { status: "paused", reason: "approval_required" };
    }

    // Resolve skill
    let skill: SkillReference | null = null;
    try {
      skill = await this.resolveSkill(step, context);
    } catch (err) {
      if (step.onError === "skip") {
        await onEvent?.({
          type: "data",
          data: [{ type: "stepUpdate", stepId: step.id, status: "skipped", reason: "skill_not_found" }],
        });
        return { status: "skipped", reason: "skill_not_found" };
      }
      return {
        status: "failed",
        error: `Failed to resolve skill: ${err instanceof Error ? err.message : String(err)}`,
        failWorkflow: step.onError === "fail",
      };
    }

    if (!skill) {
      if (step.onError === "skip") {
        await onEvent?.({
          type: "data",
          data: [{ type: "stepUpdate", stepId: step.id, status: "skipped", reason: "skill_not_found" }],
        });
        return { status: "skipped", reason: "skill_not_found" };
      }
      return { status: "failed", error: "Skill not found", failWorkflow: step.onError === "fail" };
    }

    // Trust check
    const trustCheck = this.cognium.checkTrust(skill, context.appetite);
    if (trustCheck.blocked) {
      return {
        status: "failed",
        error: trustCheck.warning ?? `Skill "${skill.slug}" blocked by trust check`,
        failWorkflow: true,
      };
    }

    // Emit step-start event
    await onEvent?.({
      type: "step-start",
      messageId: `step_${step.id}`,
      stepId: step.id,
      skillSlug: skill.slug,
      skillId: skill.id,
    });

    await onEvent?.({
      type: "data",
      data: [{ type: "stepUpdate", stepId: step.id, status: "started", skillSlug: skill.slug }],
    });

    // Resolve input mapping (including $context references)
    const input = this.resolveInputMapping(step.inputMapping, outputs, context.context);

    // Execute with retry support
    let lastError: string | undefined;
    const maxAttempts = step.retry ? step.retry.count + 1 : 1;
    const stepStart = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.executor.execute(skill, input, context.tenantId);

        if (result.success) {
          step.status = "completed";
          step.skill = skill;
          step.result = result;

          const durationMs = Date.now() - stepStart;

          await onEvent?.({
            type: "step-finish",
            finishReason: "complete",
            stepId: step.id,
            skillSlug: skill.slug,
            success: true,
            durationMs,
          });

          await onEvent?.({
            type: "data",
            data: [{ type: "stepUpdate", stepId: step.id, status: "completed", skillSlug: skill.slug, durationMs }],
          });

          return { status: "completed", result: result.output };
        }

        lastError = result.error;

        if (attempt < maxAttempts && step.retry) {
          // Emit retry event
          await onEvent?.({
            type: "data",
            data: [{ type: "stepUpdate", stepId: step.id, status: "retrying", attempt, maxAttempts, error: lastError }],
          });

          // Wait before retry
          const delay = step.retry.backoff === "exponential"
            ? step.retry.delayMs * Math.pow(2, attempt - 1)
            : step.retry.delayMs;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // All attempts failed
    const durationMs = Date.now() - stepStart;
    step.status = "failed";

    await onEvent?.({
      type: "step-finish",
      finishReason: "error",
      stepId: step.id,
      skillSlug: skill.slug,
      success: false,
      durationMs,
      error: lastError,
    });

    if (step.onError === "skip") {
      await onEvent?.({
        type: "data",
        data: [{ type: "stepUpdate", stepId: step.id, status: "skipped", reason: "execution_failed", error: lastError }],
      });
      return { status: "skipped", reason: "execution_failed", error: lastError };
    }

    await onEvent?.({
      type: "data",
      data: [{ type: "stepUpdate", stepId: step.id, status: "failed", error: lastError, durationMs }],
    });

    return { status: "failed", error: lastError, failWorkflow: step.onError === "fail" };
  }

  /**
   * Resolve a skill reference (static or dynamic binding).
   */
  private async resolveSkill(
    step: DAGStep,
    context: DAGExecutionContext,
  ): Promise<SkillReference | null> {
    if (step.binding === "static") {
      // Static binding: skillRef is "slug@version"
      const [slug, version] = step.skillRef.split("@");
      const skill = await this.runics.getSkill(slug, version || "latest");
      return skill;
    } else {
      // Dynamic binding: skillRef is a natural language query
      const searchResult = await this.runics.findSkill(step.skillRef, context.appetite);
      if (searchResult.match === "no_match" || !searchResult.skills?.length) {
        return null;
      }
      return searchResult.skills[0];
    }
  }

  /**
   * Resolve input mapping with template expressions.
   * Supports $prev, $step.N, and $context references.
   */
  private resolveInputMapping(
    mapping: Record<string, unknown> | undefined,
    outputs: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!mapping) return {};

    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(mapping)) {
      resolved[key] = this.resolveValue(value, outputs, context);
    }

    return resolved;
  }

  /**
   * Recursively resolve a value (handles nested objects and arrays).
   */
  private resolveValue(
    value: unknown,
    outputs: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): unknown {
    if (typeof value === "string") {
      return this.resolveTemplateExpression(value, outputs, context);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.resolveValue(v, outputs, context));
    }
    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveValue(v, outputs, context);
      }
      return resolved;
    }
    return value;
  }

  /**
   * Resolve a single template expression.
   * Supports: $prev, $prev.path, $step.N.path, $context.key
   */
  private resolveTemplateExpression(
    expr: string,
    outputs: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): unknown {
    // $prev — last step output
    if (expr === "$prev") {
      const keys = Object.keys(outputs);
      return keys.length > 0 ? outputs[keys[keys.length - 1]] : undefined;
    }

    // $prev.path — navigate into last step output
    if (expr.startsWith("$prev.")) {
      const path = expr.slice(6);
      const keys = Object.keys(outputs);
      if (keys.length === 0) return undefined;
      return this.navigatePath(outputs[keys[keys.length - 1]], path);
    }

    // $context — entire context object
    if (expr === "$context") {
      return context ?? {};
    }

    // $context.key.path — navigate into workflow context
    if (expr.startsWith("$context.")) {
      const path = expr.slice(9);
      return this.navigatePath(context ?? {}, path);
    }

    // $step.N or $step.name — specific step output
    const stepMatch = expr.match(/^\$step\.(\w+)(\.(.+))?$/);
    if (stepMatch) {
      const stepId = stepMatch[1];
      const path = stepMatch[3];
      const stepOutput = outputs[stepId];
      if (!path) return stepOutput;
      return this.navigatePath(stepOutput, path);
    }

    // Not a template — return as-is
    return expr;
  }

  /**
   * Navigate a dot-separated path into an object.
   */
  private navigatePath(obj: unknown, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Resume a paused DAG workflow after approval.
   */
  async resumeDAG(
    state: DAGExecutionState,
    approved: boolean,
    executionCtx: ExecutionContext,
    onEvent?: OnStreamEvent,
  ): Promise<DAGExecutionState> {
    if (!approved) {
      state.status = "failed";
      state.error = "Workflow rejected by reviewer";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      await onEvent?.({
        type: "error",
        errorText: state.error,
      });

      // Fire callback for rejected workflow
      if (state.context?.callbackUrl) {
        this.fireCallback(state, state.context, executionCtx);
      }

      return state;
    }

    // Ensure we have the DAG and context stored
    if (!state.dag || !state.context) {
      state.status = "failed";
      state.error = "Cannot resume: DAG or context not found in state";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);
      return state;
    }

    const dag = state.dag;
    const context = state.context;

    this.log?.info("Resuming DAG execution", {
      workflowId: dag.id,
      previousStatus: state.status,
      currentLayer: state.currentLayer,
      pausedStepId: state.pausedStepId,
    });

    state.status = "running";

    try {
      const layers = toExecutionLayers(dag);

      // If paused at a specific step (approval gate), mark it as approved and continue
      if (state.pausedStepId) {
        const pausedStep = dag.steps.find((s) => s.id === state.pausedStepId);
        if (pausedStep) {
          // Clear the approval requirement for this step (it's been approved)
          pausedStep.requiresApproval = false;
        }
        state.pausedStepId = undefined;
      }

      // Resume from current layer
      const startLayer = state.currentLayer ?? 0;

      for (let i = startLayer; i < layers.length; i++) {
        const layer = layers[i];
        state.currentLayer = layer.index;

        // For step_by_step mode, pause before each layer after the first resumed one
        if (context.mode === "step_by_step" && i > startLayer) {
          state.status = "paused_at_step";
          await this.persistState(state);

          await onEvent?.({
            type: "data",
            data: [{ type: "approval-required", workflowId: dag.id, layer: layer.index, reason: "step_by_step" }],
          });

          return state;
        }

        // Filter out steps that are already completed in outputs
        const pendingStepIds = layer.stepIds.filter((id) => !(id in state.outputs));

        if (pendingStepIds.length === 0) {
          // All steps in this layer already completed, skip to next
          continue;
        }

        // Execute pending steps in this layer
        const layerResults = await this.executeLayer(
          dag,
          { index: layer.index, stepIds: pendingStepIds },
          state.outputs,
          context,
          executionCtx,
          onEvent,
        );

        // Check for failures or pauses
        for (const [stepId, result] of Object.entries(layerResults)) {
          if (result.status === "paused") {
            state.status = "paused_for_review";
            state.pausedStepId = stepId;
            await this.persistState(state);

            await onEvent?.({
              type: "data",
              data: [{ type: "approval-required", workflowId: dag.id, stepId, reason: "approval_gate" }],
            });

            return state;
          }
          if (result.status === "failed" && result.failWorkflow) {
            state.status = "failed";
            state.error = `Step "${stepId}" failed: ${result.error}`;
            state.completedAt = new Date().toISOString();
            await this.persistState(state);

            await onEvent?.({
              type: "error",
              errorText: state.error,
            });

            // Fire callback for failed workflow
            this.fireCallback(state, context, executionCtx);

            return state;
          }
        }

        // Merge layer results into outputs
        Object.assign(state.outputs, layerResults);
      }

      // Workflow completed successfully
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      this.log?.info("DAG execution resumed and completed", {
        workflowId: dag.id,
        durationMs: Date.now() - new Date(state.startedAt).getTime(),
      });

      await onEvent?.({
        type: "data",
        data: [{ type: "workflow-complete", workflowId: dag.id, status: state.status }],
      });

      // Fire callback for completed workflow
      this.fireCallback(state, context, executionCtx);

      return state;
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      this.log?.error("DAG resume failed", {
        workflowId: dag.id,
        error: state.error,
      });

      await onEvent?.({
        type: "error",
        errorText: state.error,
      });

      // Fire callback for failed workflow (if context available)
      if (state.context) {
        this.fireCallback(state, state.context, executionCtx);
      }

      return state;
    }
  }

  /**
   * Load DAG execution state from KV.
   */
  async loadDAGState(workflowId: string): Promise<DAGExecutionState | null> {
    try {
      const raw = await this.env.WORKFLOW_STATE.get(`dag:${workflowId}`);
      if (!raw) return null;
      return JSON.parse(raw) as DAGExecutionState;
    } catch (err) {
      this.log?.error("Failed to load DAG state", {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Persist DAG execution state to KV.
   */
  private async persistState(state: DAGExecutionState): Promise<void> {
    try {
      await this.env.WORKFLOW_STATE.put(
        `dag:${state.workflowId}`,
        JSON.stringify(state),
        { expirationTtl: 86400 * 7 },
      );
    } catch (err) {
      this.log?.warn("KV persist failed", {
        workflowId: state.workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fire callback URL with final workflow state (fire-and-forget).
   * Called when workflow reaches a terminal state (completed, failed, terminated).
   */
  private fireCallback(
    state: DAGExecutionState,
    context: DAGExecutionContext,
    executionCtx: ExecutionContext,
  ): void {
    if (!context.callbackUrl) return;

    const payload = {
      workflowId: state.workflowId,
      status: state.status,
      outputs: state.outputs,
      error: state.error,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    };

    // Fire-and-forget via waitUntil
    executionCtx.waitUntil(
      fetch(context.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((res) => {
          if (!res.ok) {
            this.log?.warn("Callback failed", {
              workflowId: state.workflowId,
              callbackUrl: context.callbackUrl,
              status: res.status,
            });
          } else {
            this.log?.debug("Callback sent", {
              workflowId: state.workflowId,
              callbackUrl: context.callbackUrl,
            });
          }
        })
        .catch((err) => {
          this.log?.warn("Callback error", {
            workflowId: state.workflowId,
            callbackUrl: context.callbackUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }
}

interface LayerStepResult {
  status: "completed" | "failed" | "skipped" | "paused";
  result?: unknown;
  error?: string;
  reason?: string;
  failWorkflow?: boolean;
}
