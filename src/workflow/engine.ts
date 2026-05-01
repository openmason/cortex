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
  OnStreamEvent,
} from "../types";
import { ExecutionRouter } from "../execution/router";
import { CogniumClient } from "../clients/cognium";
import { RunicsClient } from "../clients/runics";
import { WorkflowRepository } from "../db/repository";
import { resolveInputMapping } from "./input-mapping";
import type { LLMClient } from "../clients/llm";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

/**
 * Workflow Engine — orchestrates the full request lifecycle.
 *
 * 1. Receives a plan (list of skills to execute)
 * 2. Respects execution mode (full_auto / review_before_run / step_by_step)
 * 3. Resolves input mappings between steps ($prev, $step.N)
 * 4. Runs each step through the execution router
 * 5. Records results to KV (live state) and DB (durable record)
 */
export class WorkflowEngine {
  private executor: ExecutionRouter;
  private cognium: CogniumClient;
  private runics: RunicsClient;
  private repo: WorkflowRepository | null;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(private env: Env, llm?: LLMClient, log?: Logger, metrics?: Metrics) {
    this.executor = new ExecutionRouter(env, llm, log?.child({ module: "router" }), metrics);
    this.cognium = new CogniumClient();
    this.runics = new RunicsClient(env);
    this.log = log;
    this.metrics = metrics;

    // DB repository is optional — only available when Hyperdrive is configured
    try {
      this.repo = new WorkflowRepository(env, log?.child({ module: "db" }));
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
    onEvent?: OnStreamEvent,
    conversationId?: string,
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
      conversationId,
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
      state.timeoutAt = new Date(Date.now() + this.getTimeoutMs()).toISOString();
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
    // Check timeout before allowing resume
    state = await this.checkAndApplyTimeout(state);
    if (state.status === "timed_out") {
      return state;
    }

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
    onEvent?: OnStreamEvent,
  ): Promise<WorkflowState> {
    const resumingAtStep = state.status === "paused_at_step" ? state.currentStepIndex : -1;
    state.status = "running";
    await this.persistState(state);

    const maxDepth = parseInt(this.env.MAX_SKILL_CHAIN_DEPTH, 10) || 10;
    const workflowStart = Date.now();

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
        state.timeoutAt = new Date(Date.now() + this.getTimeoutMs()).toISOString();
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
        type: "step-start",
        messageId: `step_${i}`,
        stepIndex: i,
        skillSlug: step.skill.slug,
        skillId: step.skill.id,
      });

      // Emit stepUpdate data event for client compatibility
      await onEvent?.({
        type: "data",
        data: [{
          type: "stepUpdate",
          stepIndex: i,
          status: "started",
          skillSlug: step.skill.slug,
          skillId: step.skill.id,
        }],
      });

      const result = await this.executor.execute(
        step.skill,
        resolvedInput,
        executionCtx,
      );

      step.result = result;

      await onEvent?.({
        type: "step-finish",
        finishReason: result.success ? "complete" : "error",
        stepIndex: i,
        skillSlug: step.skill.slug,
        success: result.success,
        durationMs: result.durationMs,
        error: result.error,
      });

      // Emit stepUpdate data event for client compatibility
      await onEvent?.({
        type: "data",
        data: [{
          type: "stepUpdate",
          stepIndex: i,
          status: result.success ? "completed" : "failed",
          skillSlug: step.skill.slug,
          durationMs: result.durationMs,
          error: result.error,
        }],
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

      this.metrics?.write("workflow", {
        tenantId: state.tenantId,
        product: state.product,
        status: "ok",
        durationMs: Date.now() - workflowStart,
      });

      await onEvent?.({
        type: "data",
        data: [{ type: "workflow-complete", workflowId: state.workflowId, status: state.status }],
      });

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
   * Check if a paused workflow has exceeded its timeout.
   * If expired, transitions to timed_out and persists.
   */
  async checkAndApplyTimeout(state: WorkflowState): Promise<WorkflowState> {
    if (
      (state.status === "paused_for_review" || state.status === "paused_at_step") &&
      state.timeoutAt &&
      new Date(state.timeoutAt).getTime() <= Date.now()
    ) {
      state.status = "timed_out";
      state.error = "Workflow timed out waiting for human review";
      state.completedAt = new Date().toISOString();
      await this.persistState(state);

      if (this.repo) {
        this.repo.updateSession(state).catch((err) =>
          this.log?.error("Failed to update timed_out session in DB", { error: err instanceof Error ? err.message : String(err), workflowId: state.workflowId }),
        );
      }
    }
    return state;
  }

  /**
   * Terminate a running or paused workflow.
   * Can only terminate workflows that are not already in a terminal state.
   */
  async terminate(state: WorkflowState, reason?: string): Promise<WorkflowState> {
    const terminalStatuses: WorkflowStatus[] = ["completed", "failed", "timed_out", "terminated"];
    if (terminalStatuses.includes(state.status)) {
      // Already in terminal state, return as-is
      return state;
    }

    state.status = "terminated";
    state.error = reason ?? "Workflow terminated by user";
    state.completedAt = new Date().toISOString();
    await this.persistState(state);

    // Update DB (best-effort, non-blocking)
    if (this.repo) {
      Promise.resolve(this.repo.updateSession(state)).catch((err) =>
        this.log?.error("Failed to update terminated session in DB", {
          error: err instanceof Error ? err.message : String(err),
          workflowId: state.workflowId,
        }),
      );
    }

    this.log?.info("Workflow terminated", { workflowId: state.workflowId, reason });
    this.metrics?.write("workflow", {
      tenantId: state.tenantId,
      product: state.product,
      status: "terminated",
      durationMs: Date.now() - new Date(state.startedAt).getTime(),
    });

    return state;
  }

  private getTimeoutMs(): number {
    return parseInt(this.env.WORKFLOW_TIMEOUT_MS, 10) || 300_000;
  }

  /**
   * Persist workflow state to KV for durability.
   * Best-effort — KV free tier has daily write limits.
   */
  private async persistState(state: WorkflowState): Promise<void> {
    try {
      await this.env.WORKFLOW_STATE.put(
        `workflow:${state.workflowId}`,
        JSON.stringify(state),
        { expirationTtl: 86400 * 7 }, // 7 days
      );
    } catch (err) {
      this.log?.warn("KV persist failed", { workflowId: state.workflowId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Load workflow state from KV, falling back to DB if KV has expired.
   */
  async loadState(workflowId: string): Promise<WorkflowState | null> {
    // Fast path: KV
    const raw = await this.env.WORKFLOW_STATE.get(`workflow:${workflowId}`);
    if (raw) return JSON.parse(raw);

    // Fallback: reconstruct from DB if available
    if (!this.repo) return null;

    try {
      const session = await this.repo.getSessionByWorkflowId(workflowId);
      if (!session) return null;

      return {
        workflowId: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        product: session.product as WorkflowState["product"],
        mode: session.mode as ExecutionMode,
        plan: session.planJson as unknown as WorkflowPlan,
        currentStepIndex: session.currentStepIndex ?? 0,
        status: session.status as WorkflowStatus,
        startedAt: session.startedAt.toISOString(),
        completedAt: session.completedAt?.toISOString(),
        pausedAt: session.pausedAt?.toISOString(),
        resumeData: session.resumeData as WorkflowState["resumeData"],
        error: session.error ?? undefined,
      };
    } catch (err) {
      this.log?.error("DB fallback failed for loadState", { error: err instanceof Error ? err.message : String(err), workflowId });
      return null;
    }
  }
}
