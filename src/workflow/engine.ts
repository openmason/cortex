import type {
  Env,
  WorkflowState,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStatus,
  ExecutionResult,
  ExecutionMode,
  TenantContext,
  SkillReference,
  SSEEvent,
} from "../types";
import { ExecutionRouter } from "../execution/router";
import { CogniumClient } from "../clients/cognium";
import { RunicsClient } from "../clients/runics";
import { ForgeClient } from "../clients/forge";
import { WorkflowRepository } from "../db/repository";
import { resolveInputMapping } from "./input-mapping";

/**
 * Workflow Engine — orchestrates the full request lifecycle.
 *
 * 1. Receives a plan (list of skills to execute)
 * 2. Respects execution mode (full_auto / review_before_run / step_by_step)
 * 3. Resolves input mappings between steps ($prev, $step.N)
 * 4. Runs each step through the execution router
 * 5. Records results to KV (live state) and DB (durable record)
 * 6. Triggers post-workflow hooks (Forge auto-distillation)
 */
export class WorkflowEngine {
  private executor: ExecutionRouter;
  private cognium: CogniumClient;
  private runics: RunicsClient;
  private forge: ForgeClient;
  private repo: WorkflowRepository | null;

  constructor(private env: Env) {
    this.executor = new ExecutionRouter(env);
    this.cognium = new CogniumClient(env);
    this.runics = new RunicsClient(env);
    this.forge = new ForgeClient(env);

    // DB repository is optional — only available when Hyperdrive is configured
    try {
      this.repo = new WorkflowRepository(env);
    } catch {
      this.repo = null;
    }
  }

  /**
   * Start a new workflow from a plan. Returns immediately if mode
   * requires human review (paused_for_review).
   */
  async start(
    plan: WorkflowPlan,
    tenant: TenantContext,
    executionCtx: ExecutionContext,
    prompt?: string,
    onEvent?: (event: SSEEvent) => void | Promise<void>,
  ): Promise<WorkflowState> {
    const state: WorkflowState = {
      workflowId: plan.id,
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      product: tenant.product,
      mode: plan.mode,
      plan,
      currentStepIndex: 0,
      status: "planning",
      startedAt: new Date().toISOString(),
    };

    // Pre-flight: trust check all skills in the plan
    for (const step of plan.steps) {
      const check = this.cognium.checkTrust(step.skill, tenant.appetite);
      if (check.blocked) {
        state.status = "failed";
        state.error = check.warning ?? `Skill ${step.skill.slug} blocked by trust check`;
        await this.persistState(state);
        return state;
      }
      // Attach warnings to steps for downstream visibility
      if (check.warning) {
        step.condition = {
          ...step.condition,
          _trustWarning: check.warning,
        };
      }
    }

    // Persist to DB (non-blocking)
    if (this.repo && prompt) {
      executionCtx.waitUntil(this.repo.createSession(state, prompt));
    }

    // Pause for review if mode requires it
    if (plan.mode === "review_before_run" || plan.mode === "step_by_step") {
      state.status = "paused_for_review";
      state.pausedAt = new Date().toISOString();
      await this.persistState(state);
      return state;
    }

    // Full auto — execute immediately
    return this.executeWorkflow(state, executionCtx, onEvent);
  }

  /**
   * Resume a paused workflow after human review/approval.
   */
  async resume(
    state: WorkflowState,
    approved: boolean,
    modifiedPlan?: WorkflowPlan,
    executionCtx?: ExecutionContext,
  ): Promise<WorkflowState> {
    if (!approved) {
      state.status = "failed";
      state.error = "Workflow rejected by human reviewer";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);
      return state;
    }

    // Apply modifications if the reviewer changed the plan
    if (modifiedPlan) {
      state.plan = modifiedPlan;
      state.resumeData = { originalPlan: state.plan, modifiedAt: new Date().toISOString() };
    }

    return this.executeWorkflow(state, executionCtx!);
  }

  /**
   * Execute the workflow steps sequentially.
   */
  private async executeWorkflow(
    state: WorkflowState,
    executionCtx: ExecutionContext,
    onEvent?: (event: SSEEvent) => void | Promise<void>,
  ): Promise<WorkflowState> {
    const resumingAtStep = state.status === "paused_at_step" ? state.currentStepIndex : -1;
    state.status = "running";
    await this.persistState(state);

    const maxDepth = parseInt(this.env.MAX_SKILL_CHAIN_DEPTH, 10) || 10;

    for (let i = state.currentStepIndex; i < state.plan.steps.length; i++) {
      if (i >= maxDepth) {
        state.status = "failed";
        state.error = `Workflow exceeded max chain depth (${maxDepth})`;
        break;
      }

      const step = state.plan.steps[i];
      state.currentStepIndex = i;

      // Step-by-step mode: pause before each step (but not when
      // resuming the step we were already paused at)
      if (state.mode === "step_by_step" && i > 0 && i !== resumingAtStep) {
        state.status = "paused_at_step";
        state.pausedAt = new Date().toISOString();
        await this.persistState(state);
        return state;
      }

      // Resolve input mapping ($prev, $step.N, $context)
      const resolvedInput = resolveInputMapping(
        step.inputMapping as Record<string, unknown> | undefined,
        state.plan.steps,
        i,
      );

      // Execute the step
      step.status = "running";
      await this.persistState(state);

      await onEvent?.({
        event: "step_start",
        data: { stepIndex: i, skillSlug: step.skill.slug, skillId: step.skill.id },
      });

      const result = await this.executor.execute(
        step.skill,
        resolvedInput,
        executionCtx,
      );

      step.result = result;

      await onEvent?.({
        event: "step_complete",
        data: {
          stepIndex: i,
          skillSlug: step.skill.slug,
          success: result.success,
          durationMs: result.durationMs,
          error: result.error,
        },
      });

      // Record step execution to DB (non-blocking)
      if (this.repo) {
        executionCtx.waitUntil(
          this.repo.recordStepExecution(
            state.workflowId,
            i,
            step.skill,
            resolvedInput,
            result,
          ),
        );
      }

      if (result.success) {
        step.status = "completed";

        // Record invocation to Runics (non-blocking)
        executionCtx.waitUntil(
          this.runics.recordInvocation(
            step.skill.id,
            null,
            state.tenantId,
            result.durationMs,
            true,
          ),
        );
      } else {
        // Handle error based on step's onError policy
        switch (step.onError) {
          case "skip":
            step.status = "skipped";
            break;
          case "retry":
            // One retry attempt
            const retryResult = await this.executor.execute(
              step.skill,
              resolvedInput,
              executionCtx,
            );
            step.result = retryResult;
            if (retryResult.success) {
              step.status = "completed";
            } else {
              step.status = "failed";
              state.status = "failed";
              state.error = `Step ${i} (${step.skill.slug}) failed after retry: ${retryResult.error}`;
              await this.persistState(state);
              return state;
            }
            break;
          case "fail":
          default:
            step.status = "failed";
            state.status = "failed";
            state.error = `Step ${i} (${step.skill.slug}) failed: ${result.error}`;
            await this.persistState(state);

            // Record failed invocation
            executionCtx.waitUntil(
              this.runics.recordInvocation(
                step.skill.id,
                null,
                state.tenantId,
                result.durationMs,
                false,
              ),
            );
            return state;
        }
      }

      await this.persistState(state);
    }

    // Workflow completed successfully
    if (state.status === "running") {
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      await onEvent?.({
        event: "workflow_complete",
        data: { workflowId: state.workflowId, status: state.status },
      });

      // Post-workflow: trigger Forge auto-distillation (non-blocking)
      executionCtx.waitUntil(this.forge.autoDistill(state));

      // Write execution trace to DB (non-blocking)
      if (this.repo) {
        const userModified = !!state.resumeData;
        executionCtx.waitUntil(
          this.repo.writeTrace(state, "", userModified),
        );
      }
    }

    // Update DB session (non-blocking)
    if (this.repo) {
      executionCtx.waitUntil(this.repo.updateSession(state));
    }

    return state;
  }

  /**
   * Persist workflow state to KV for durability.
   */
  private async persistState(state: WorkflowState): Promise<void> {
    await this.env.WORKFLOW_STATE.put(
      `workflow:${state.workflowId}`,
      JSON.stringify(state),
      { expirationTtl: 86400 * 7 }, // 7 days
    );
  }

  /**
   * Load workflow state from KV.
   */
  async loadState(workflowId: string): Promise<WorkflowState | null> {
    const raw = await this.env.WORKFLOW_STATE.get(`workflow:${workflowId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }
}
