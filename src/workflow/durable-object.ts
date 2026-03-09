import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  WorkflowState,
  WorkflowPlan,
  WorkflowStep,
  WorkflowStatus,
  ExecutionResult,
  TenantContext,
} from "../types";
import { ExecutionRouter } from "../execution/router";
import { CogniumClient } from "../clients/cognium";
import { RunicsClient } from "../clients/runics";
import { ForgeClient } from "../clients/forge";

/**
 * WorkflowDurableObject — durable execution with pause/resume.
 *
 * Each workflow gets its own DO instance (keyed by workflowId).
 * State survives across requests, enabling:
 * - review_before_run: pause after planning, resume after approval
 * - step_by_step: pause before each step, resume after confirmation
 * - Timeout alarms: auto-fail workflows that exceed the timeout
 */
export class WorkflowDurableObject extends DurableObject<Env> {
  private state: WorkflowState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // -----------------------------------------------------------------------
  // HTTP handler — all workflow operations go through fetch
  // -----------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "POST" && path === "/start") {
        return this.handleStart(request);
      }
      if (request.method === "POST" && path === "/resume") {
        return this.handleResume(request);
      }
      if (request.method === "GET" && path === "/state") {
        return this.handleGetState();
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  // -----------------------------------------------------------------------
  // Alarm — timeout handling
  // -----------------------------------------------------------------------
  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (!state) return;

    // Only timeout workflows that are still waiting
    if (state.status === "paused_for_review" || state.status === "paused_at_step") {
      state.status = "timed_out";
      state.error = "Workflow timed out waiting for human review";
      state.completedAt = new Date().toISOString();
      await this.saveState(state);
    }
  }

  // -----------------------------------------------------------------------
  // Start a new workflow
  // -----------------------------------------------------------------------
  private async handleStart(request: Request): Promise<Response> {
    const { plan, tenant } = (await request.json()) as {
      plan: WorkflowPlan;
      tenant: TenantContext;
    };

    const cognium = new CogniumClient(this.env);

    // Build initial state
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

    // Pre-flight trust checks on all skills
    for (const step of plan.steps) {
      const check = cognium.checkTrust(step.skill, tenant.appetite);
      if (check.blocked) {
        state.status = "failed";
        state.error = check.warning ?? `Skill ${step.skill.slug} blocked by trust check`;
        await this.saveState(state);
        return Response.json(state);
      }
      if (check.warning) {
        step.condition = { ...step.condition, _trustWarning: check.warning };
      }
    }

    // Set timeout alarm
    const timeoutMs = parseInt(this.env.WORKFLOW_TIMEOUT_MS, 10) || 300_000;
    await this.ctx.storage.setAlarm(Date.now() + timeoutMs);

    // Pause for review if mode requires it
    if (plan.mode === "review_before_run" || plan.mode === "step_by_step") {
      state.status = "paused_for_review";
      state.pausedAt = new Date().toISOString();
      await this.saveState(state);
      return Response.json(state);
    }

    // Full auto — execute immediately
    const result = await this.executeWorkflow(state);
    return Response.json(result);
  }

  // -----------------------------------------------------------------------
  // Resume a paused workflow
  // -----------------------------------------------------------------------
  private async handleResume(request: Request): Promise<Response> {
    const { approved, modifiedPlan } = (await request.json()) as {
      approved: boolean;
      modifiedPlan?: WorkflowPlan;
    };

    const state = await this.loadState();
    if (!state) {
      return Response.json({ error: "No workflow state found" }, { status: 404 });
    }

    if (
      state.status !== "paused_for_review" &&
      state.status !== "paused_at_step"
    ) {
      return Response.json(
        { error: `Cannot resume workflow in status: ${state.status}` },
        { status: 409 },
      );
    }

    if (!approved) {
      state.status = "failed";
      state.error = "Workflow rejected by human reviewer";
      state.completedAt = new Date().toISOString();
      await this.saveState(state);
      await this.ctx.storage.deleteAlarm();
      return Response.json(state);
    }

    if (modifiedPlan) {
      state.resumeData = { originalPlan: state.plan, modifiedAt: new Date().toISOString() };
      state.plan = modifiedPlan;
    }

    const result = await this.executeWorkflow(state);
    return Response.json(result);
  }

  // -----------------------------------------------------------------------
  // Get current state
  // -----------------------------------------------------------------------
  private async handleGetState(): Promise<Response> {
    const state = await this.loadState();
    if (!state) {
      return Response.json({ error: "No workflow state found" }, { status: 404 });
    }
    return Response.json(state);
  }

  // -----------------------------------------------------------------------
  // Execution loop
  // -----------------------------------------------------------------------
  private async executeWorkflow(state: WorkflowState): Promise<WorkflowState> {
    const resumingAtStep =
      state.status === "paused_at_step" ? state.currentStepIndex : -1;
    state.status = "running";
    await this.saveState(state);

    const executor = new ExecutionRouter(this.env);
    const runics = new RunicsClient(this.env);
    const maxDepth = parseInt(this.env.MAX_SKILL_CHAIN_DEPTH, 10) || 10;

    for (let i = state.currentStepIndex; i < state.plan.steps.length; i++) {
      if (i >= maxDepth) {
        state.status = "failed";
        state.error = `Workflow exceeded max chain depth (${maxDepth})`;
        break;
      }

      const step = state.plan.steps[i];
      state.currentStepIndex = i;

      // Step-by-step: pause before each step (skip the one we're resuming from)
      if (state.mode === "step_by_step" && i > 0 && i !== resumingAtStep) {
        state.status = "paused_at_step";
        state.pausedAt = new Date().toISOString();
        await this.saveState(state);
        return state;
      }

      // Execute
      step.status = "running";
      await this.saveState(state);

      // Create a minimal execution context for the router
      const execCtx = {
        waitUntil: (_p: Promise<unknown>) => {
          // In DO context, we can't use waitUntil — fire and forget
          _p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;

      const result = await executor.execute(
        step.skill,
        (step.inputMapping as Record<string, unknown>) ?? {},
        execCtx,
      );

      step.result = result;

      if (result.success) {
        step.status = "completed";

        // Record invocation (best effort)
        runics
          .recordInvocation(step.skill.id, null, state.tenantId, result.durationMs, true)
          .catch(() => {});
      } else {
        switch (step.onError) {
          case "skip":
            step.status = "skipped";
            break;

          case "retry": {
            const retryResult = await executor.execute(
              step.skill,
              (step.inputMapping as Record<string, unknown>) ?? {},
              execCtx,
            );
            step.result = retryResult;
            if (retryResult.success) {
              step.status = "completed";
            } else {
              step.status = "failed";
              state.status = "failed";
              state.error = `Step ${i} (${step.skill.slug}) failed after retry: ${retryResult.error}`;
              await this.saveState(state);
              return state;
            }
            break;
          }

          case "fail":
          default:
            step.status = "failed";
            state.status = "failed";
            state.error = `Step ${i} (${step.skill.slug}) failed: ${result.error}`;
            await this.saveState(state);

            runics
              .recordInvocation(step.skill.id, null, state.tenantId, result.durationMs, false)
              .catch(() => {});
            return state;
        }
      }

      await this.saveState(state);
    }

    // Completed
    if (state.status === "running") {
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      await this.saveState(state);
      await this.ctx.storage.deleteAlarm();

      // Trigger Forge auto-distillation (best effort)
      const forge = new ForgeClient(this.env);
      forge.autoDistill(state).catch(() => {});
    }

    return state;
  }

  // -----------------------------------------------------------------------
  // Persistence (DO storage — survives restarts)
  // -----------------------------------------------------------------------
  private async saveState(state: WorkflowState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put("workflow_state", state);
  }

  private async loadState(): Promise<WorkflowState | null> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<WorkflowState>("workflow_state");
    this.state = stored ?? null;
    return this.state;
  }
}
