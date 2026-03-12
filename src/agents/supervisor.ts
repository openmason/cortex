import type {
  Env,
  TenantContext,
  WorkflowPlan,
  WorkflowStep,
  WorkflowState,
  FindSkillResponse,
  SkillReference,
  RunRequest,
  RunResponse,
  SSEEvent,
  SaveAsSkillResponse,
} from "../types";
import { RunicsClient } from "../clients/runics";
import { LLMClient, type ChatMessage } from "../clients/llm";
import { WorkflowEngine } from "../workflow/engine";
import { PolicyEngine } from "../policy/engine";
import { ConversationManager, type ConversationState } from "../conversation/manager";
import { getProductConfig } from "./product-configs";
import { ToolExecutor, getToolsForProduct } from "./tools";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

/**
 * Supervisor Agent — the brain of Cortex.
 *
 * Every user request becomes a supervisor session:
 * 1. LLM parses the user's intent
 * 2. LLM calls tools to discover skills, check policies, and build a plan
 * 3. Plan is validated and checked against tenant policies
 * 4. Workflow is executed via WorkflowEngine
 *
 * The supervisor uses LiteLLM (OpenAI-compatible) for planning.
 * Tools are defined in ./tools.ts and executed by ToolExecutor.
 */
export class SupervisorAgent {
  private runics: RunicsClient;
  private llm: LLMClient;
  private engine: WorkflowEngine;
  private policyEngine: PolicyEngine;
  private conversations: ConversationManager;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(private env: Env, log?: Logger, metrics?: Metrics) {
    this.runics = new RunicsClient(env);
    this.llm = new LLMClient(env, log?.child({ module: "llm" }), metrics);
    this.engine = new WorkflowEngine(env, this.llm, log?.child({ module: "engine" }), metrics);
    this.policyEngine = new PolicyEngine(env);
    this.conversations = new ConversationManager(env);
    this.log = log;
    this.metrics = metrics;
  }

  /**
   * Handle a new user request end-to-end.
   *
   * The LLM drives the entire flow: it searches for skills, checks policies,
   * and produces a plan — all via tool calls in an agentic loop.
   */
  async handleRequest(
    request: RunRequest,
    executionCtx: ExecutionContext,
  ): Promise<RunResponse> {
    const config = getProductConfig(request.product);

    const tenant: TenantContext = {
      tenantId: request.tenantId,
      userId: request.userId,
      product: request.product,
      appetite: request.appetite ?? config.defaultAppetite,
      executionMode: request.mode ?? config.defaultMode,
    };

    // --- Conversation: load or create ---
    let convState: ConversationState;
    let conversationId: string;

    if (request.conversationId) {
      const loaded = await this.conversations.load(request.tenantId, request.conversationId);
      if (!loaded) {
        return {
          workflowId: crypto.randomUUID(),
          status: "failed",
          summary: "Conversation not found or expired.",
          conversationId: request.conversationId,
        };
      }
      convState = loaded;
      conversationId = request.conversationId;
    } else {
      conversationId = this.conversations.generateId();
      convState = this.conversations.createState(
        conversationId,
        request.tenantId,
        request.userId,
        request.product,
      );
    }

    // Create tool executor for this session
    const toolExecutor = new ToolExecutor(this.env, tenant, this.llm, this.log?.child({ module: "tools" }), this.metrics);
    const tools = getToolsForProduct(request.product);

    // Build messages with conversation history
    const systemPrompt = this.buildSystemPrompt(config.systemPrompt, tenant);
    const messages = this.conversations.buildMessagesWithHistory(
      systemPrompt,
      request.prompt,
      request.context,
      convState.messages,
    );

    // Run the agentic loop — the LLM will call findSkill, checkPolicy, buildPlan, etc.
    const toolModel = await this.llm.getToolCallModel();
    let agentResult: { messages: ChatMessage[]; finalContent: string };
    try {
      agentResult = await this.llm.agentLoop(
        messages,
        tools,
        (name, args) => toolExecutor.execute(name, args, executionCtx),
        { model: toolModel, maxTurns: 8, temperature: 0.2 },
      );
    } catch (err) {
      return {
        workflowId: crypto.randomUUID(),
        status: "failed",
        summary: `LLM planning failed: ${err instanceof Error ? err.message : String(err)}`,
        conversationId,
      };
    }

    // --- Conversation: persist updated history ---
    const newMessages = this.conversations.extractPersistableMessages(agentResult.messages);
    // newMessages includes the re-loaded history (as user/assistant) plus new turn messages.
    // convState.messages has the raw history; newMessages[0..historyLen-1] mirrors it.
    const currentTurnMessages = newMessages.slice(convState.messages.length);
    convState.messages.push(...currentTurnMessages);
    convState.turnCount++;
    executionCtx.waitUntil(this.conversations.save(convState));

    // Extract the plan from the tool calls (look for the last buildPlan result)
    const plan = this.extractPlanFromMessages(agentResult.messages, toolExecutor, tenant);

    if (!plan) {
      // No plan was built — the LLM may have answered directly or found no skills
      return {
        workflowId: crypto.randomUUID(),
        status: "completed",
        summary: agentResult.finalContent || "No actionable skills found for your request.",
        conversationId,
      };
    }

    // Policy check (CoStaff / ControlCenter)
    if (config.enablePolicyEngine) {
      const policy = await this.policyEngine.loadPolicy(tenant.tenantId, tenant.product);
      const policyResult = await this.policyEngine.checkPlan(plan, tenant, policy);

      if (!policyResult.allowed) {
        const reasons = policyResult.violations.map((v) => v.message).join("; ");
        return {
          workflowId: plan.id,
          status: "failed",
          plan,
          summary: `Blocked by policy: ${reasons}`,
          conversationId,
        };
      }

      if (policyResult.requiresReview && plan.mode === "full_auto") {
        plan.mode = "review_before_run";
      }
    }

    // Execute via the workflow engine
    const state = await this.engine.start(plan, tenant, executionCtx);

    return this.stateToResponse(state, agentResult.finalContent, conversationId);
  }

  /**
   * Handle a request without the LLM agentic loop.
   * Used as a fallback or when LiteLLM is unavailable.
   */
  async handleRequestDirect(
    request: RunRequest,
    executionCtx: ExecutionContext,
  ): Promise<RunResponse> {
    const config = getProductConfig(request.product);

    const tenant: TenantContext = {
      tenantId: request.tenantId,
      userId: request.userId,
      product: request.product,
      appetite: request.appetite ?? config.defaultAppetite,
      executionMode: request.mode ?? config.defaultMode,
    };

    // Step 1: Discover skills via Runics
    const searchResults = await this.discoverSkills(request.prompt, tenant);

    if (searchResults.confidence === "no_match" || searchResults.results.length === 0) {
      return {
        workflowId: crypto.randomUUID(),
        status: "failed",
        summary: "No matching skills found for your request. Try rephrasing or check available skills.",
      };
    }

    // Step 2: Build the execution plan
    const plan = this.buildPlanFromSearch(searchResults, tenant);

    // Step 3: Policy check (CoStaff / ControlCenter)
    if (config.enablePolicyEngine) {
      const policy = await this.policyEngine.loadPolicy(tenant.tenantId, tenant.product);
      const policyResult = await this.policyEngine.checkPlan(plan, tenant, policy);

      if (!policyResult.allowed) {
        const reasons = policyResult.violations.map((v) => v.message).join("; ");
        return {
          workflowId: plan.id,
          status: "failed",
          plan,
          summary: `Blocked by policy: ${reasons}`,
        };
      }

      if (policyResult.requiresReview && plan.mode === "full_auto") {
        plan.mode = "review_before_run";
      }
    }

    // Step 4: Execute via the workflow engine
    const state = await this.engine.start(plan, tenant, executionCtx);

    return this.stateToResponse(state);
  }

  /**
   * Resume a paused workflow.
   */
  async handleResume(
    workflowId: string,
    approved: boolean,
    modifiedPlan: WorkflowPlan | undefined,
    executionCtx: ExecutionContext,
  ): Promise<RunResponse> {
    const state = await this.engine.loadState(workflowId);
    if (!state) {
      return {
        workflowId,
        status: "failed",
        summary: "Workflow not found or expired.",
      };
    }

    const resumed = await this.engine.resume(state, approved, modifiedPlan, executionCtx);
    return this.stateToResponse(resumed);
  }

  /**
   * Handle a streaming request — same logic as handleRequest but emits SSE events.
   */
  async handleRequestStreaming(
    request: RunRequest,
    executionCtx: ExecutionContext,
    onEvent: (event: SSEEvent) => void | Promise<void>,
  ): Promise<RunResponse> {
    const config = getProductConfig(request.product);

    const tenant: TenantContext = {
      tenantId: request.tenantId,
      userId: request.userId,
      product: request.product,
      appetite: request.appetite ?? config.defaultAppetite,
      executionMode: request.mode ?? config.defaultMode,
    };

    // --- Conversation: load or create ---
    let convState: ConversationState;
    let conversationId: string;

    if (request.conversationId) {
      const loaded = await this.conversations.load(request.tenantId, request.conversationId);
      if (!loaded) {
        await onEvent({ event: "error", data: { message: "Conversation not found or expired." } });
        await onEvent({ event: "done", data: { conversationId: request.conversationId } });
        return {
          workflowId: crypto.randomUUID(),
          status: "failed",
          summary: "Conversation not found or expired.",
          conversationId: request.conversationId,
        };
      }
      convState = loaded;
      conversationId = request.conversationId;
    } else {
      conversationId = this.conversations.generateId();
      convState = this.conversations.createState(
        conversationId,
        request.tenantId,
        request.userId,
        request.product,
      );
    }

    await onEvent({
      event: "conversation",
      data: { conversationId, isNew: !request.conversationId, turnCount: convState.turnCount },
    });

    const toolExecutor = new ToolExecutor(this.env, tenant, this.llm, this.log?.child({ module: "tools" }), this.metrics);
    const tools = getToolsForProduct(request.product);

    // Build messages with conversation history
    const systemPrompt = this.buildSystemPrompt(config.systemPrompt, tenant);
    const messages = this.conversations.buildMessagesWithHistory(
      systemPrompt,
      request.prompt,
      request.context,
      convState.messages,
    );

    await onEvent({ event: "planning", data: { prompt: request.prompt, product: request.product } });

    const toolModel = await this.llm.getToolCallModel();
    let agentResult: { messages: ChatMessage[]; finalContent: string };
    try {
      agentResult = await this.llm.agentLoop(
        messages,
        tools,
        (name, args) => toolExecutor.execute(name, args, executionCtx),
        { model: toolModel, maxTurns: 8, temperature: 0.2, onEvent },
      );
    } catch (err) {
      const errorMsg = `LLM planning failed: ${err instanceof Error ? err.message : String(err)}`;
      await onEvent({ event: "error", data: { message: errorMsg } });
      await onEvent({ event: "done", data: { conversationId } });
      return {
        workflowId: crypto.randomUUID(),
        status: "failed",
        summary: errorMsg,
        conversationId,
      };
    }

    // --- Conversation: persist updated history ---
    const newMessages = this.conversations.extractPersistableMessages(agentResult.messages);
    const currentTurnMessages = newMessages.slice(convState.messages.length);
    convState.messages.push(...currentTurnMessages);
    convState.turnCount++;
    executionCtx.waitUntil(this.conversations.save(convState));

    const plan = this.extractPlanFromMessages(agentResult.messages, toolExecutor, tenant);

    if (!plan) {
      await onEvent({ event: "done", data: { summary: agentResult.finalContent, conversationId } });
      return {
        workflowId: crypto.randomUUID(),
        status: "completed",
        summary: agentResult.finalContent || "No actionable skills found for your request.",
        conversationId,
      };
    }

    // Policy check
    if (config.enablePolicyEngine) {
      const policy = await this.policyEngine.loadPolicy(tenant.tenantId, tenant.product);
      const policyResult = await this.policyEngine.checkPlan(plan, tenant, policy);

      if (!policyResult.allowed) {
        const reasons = policyResult.violations.map((v) => v.message).join("; ");
        await onEvent({ event: "error", data: { message: `Blocked by policy: ${reasons}` } });
        await onEvent({ event: "done", data: { conversationId } });
        return {
          workflowId: plan.id,
          status: "failed",
          plan,
          summary: `Blocked by policy: ${reasons}`,
          conversationId,
        };
      }

      if (policyResult.requiresReview && plan.mode === "full_auto") {
        plan.mode = "review_before_run";
      }
    }

    // Execute with event callbacks
    const state = await this.engine.start(plan, tenant, executionCtx, undefined, onEvent);

    await onEvent({ event: "done", data: { workflowId: state.workflowId, status: state.status, conversationId } });

    return this.stateToResponse(state, agentResult.finalContent, conversationId);
  }

  /**
   * Save a completed workflow as a reusable skill (human-distill).
   */
  async saveAsSkill(
    workflowId: string,
    tenantId: string,
    userId: string,
    name: string,
    description: string,
    visibility: "public" | "team" | "private",
    tags?: string[],
    category?: string,
  ): Promise<SaveAsSkillResponse> {
    const state = await this.engine.loadState(workflowId);

    if (!state) {
      throw new Error("Workflow not found. It may have been deleted or expired.");
    }

    if (state.status !== "completed") {
      throw new Error(`Cannot save workflow with status '${state.status}'. Only completed workflows can be saved as skills.`);
    }

    // Security: validate the requesting tenant owns this workflow
    if (state.tenantId !== tenantId) {
      throw new Error("Unauthorized: this workflow belongs to a different tenant.");
    }

    const { ForgeClient } = await import("../clients/forge");
    const forge = new ForgeClient(this.env);
    const result = await forge.humanDistill({
      name,
      description,
      workflowState: state,
      userId,
      visibility,
      tags,
      category,
    });

    // Mark the execution trace as saved in the DB (non-blocking, best-effort)
    try {
      const { WorkflowRepository } = await import("../db/repository");
      const repo = new WorkflowRepository(this.env);
      await repo.markTraceAsSaved(workflowId, result.skillId);
    } catch {
      // DB marking is best-effort — don't fail the save
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildSystemPrompt(basePrompt: string, tenant: TenantContext): string {
    return `${basePrompt}

## Current session
- Product: ${tenant.product}
- Tenant: ${tenant.tenantId}
- Execution mode: ${tenant.executionMode}
- Appetite: ${tenant.appetite}

## Instructions
1. Use findSkill to search for skills that match the user's request.
2. ${tenant.product !== "bombastic" ? "Use checkPolicy to verify each skill is allowed by the tenant's policy." : "Bombastic mode — no policy checks needed."}
3. ALWAYS execute skills — never just describe what you would do. After findSkill returns results, you MUST either:
   a. Call invokeSkill directly for simple single-skill tasks, OR
   b. Call buildPlan to create a multi-step execution plan.
4. After invokeSkill completes, summarize the actual result to the user.
5. If invokeSkill fails, try a different skill from the findSkill results.

IMPORTANT: You must call tools to completion. Do NOT stop after findSkill — always follow up with invokeSkill or buildPlan.`;
  }

  /**
   * Extract a WorkflowPlan from the agent loop messages.
   * Looks for the last successful buildPlan tool result.
   */
  private extractPlanFromMessages(
    messages: ChatMessage[],
    toolExecutor: ToolExecutor,
    tenant: TenantContext,
  ): WorkflowPlan | null {
    // Find the last buildPlan tool result
    let lastPlanResult: Record<string, unknown> | null = null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "tool" && msg.content) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.planId && parsed.steps) {
            lastPlanResult = parsed;
            break;
          }
        } catch {
          // Not JSON or not a plan result
        }
      }
    }

    if (!lastPlanResult) return null;

    const discoveredSkills = toolExecutor.getDiscoveredSkills();
    const planSteps = lastPlanResult.steps as Array<{
      skillId: string;
      skillSlug: string;
      order: number;
      inputMapping?: Record<string, unknown>;
      onError?: string;
    }>;

    const steps: WorkflowStep[] = planSteps.map((s, i) => {
      const skill = discoveredSkills.get(s.skillId);
      return {
        id: crypto.randomUUID(),
        order: i,
        skill: skill ?? this.makeUnknownSkill(s.skillId, s.skillSlug),
        inputMapping: s.inputMapping,
        onError: (s.onError as "fail" | "skip" | "retry") ?? "fail",
        status: "pending" as const,
      };
    });

    return {
      id: lastPlanResult.planId as string,
      steps,
      mode: tenant.executionMode,
      createdAt: new Date().toISOString(),
    };
  }

  private makeUnknownSkill(id: string, slug: string): SkillReference {
    return {
      id,
      slug,
      version: "unknown",
      name: slug,
      executionLayer: "worker",
      trustScore: 0,
      verificationTier: "unverified",
      trustBadge: null,
      status: "published",
      skillType: "atomic",
      runCount: 0,
    };
  }

  private async discoverSkills(
    prompt: string,
    tenant: TenantContext,
  ): Promise<FindSkillResponse> {
    return this.runics.findSkill({
      query: prompt,
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      appetite: tenant.appetite,
    });
  }

  private buildPlanFromSearch(
    searchResults: FindSkillResponse,
    tenant: TenantContext,
  ): WorkflowPlan {
    const skills = searchResults.results;

    // If composition detected, use all parts; otherwise use top result
    const selectedSkills =
      searchResults.composition?.detected && skills.length > 1
        ? skills
        : [skills[0]];

    const steps: WorkflowStep[] = selectedSkills.map((skill, i) => {
      // Derive r2BundleKey for worker/container skills
      if ((skill.executionLayer === "worker" || skill.executionLayer === "container") && !skill.r2BundleKey) {
        skill.r2BundleKey = `skills/${skill.slug}/${skill.version}/bundle.js`;
      }
      return {
        id: crypto.randomUUID(),
        order: i,
        skill,
        onError: "fail" as const,
        status: "pending" as const,
      };
    });

    return {
      id: crypto.randomUUID(),
      steps,
      mode: tenant.executionMode,
      createdAt: new Date().toISOString(),
    };
  }

  private stateToResponse(state: WorkflowState, llmSummary?: string, conversationId?: string): RunResponse {
    return {
      workflowId: state.workflowId,
      status: state.status,
      plan: state.plan,
      result: state.status === "completed" ? this.collectResults(state.plan) : undefined,
      summary: llmSummary || this.buildSummary(state),
      conversationId,
    };
  }

  private collectResults(plan: WorkflowPlan): unknown {
    return plan.steps
      .filter((s) => s.status === "completed" && s.result)
      .map((s) => ({
        skill: s.skill.slug,
        output: s.result!.output,
        durationMs: s.result!.durationMs,
      }));
  }

  private buildSummary(state: WorkflowState): string {
    switch (state.status) {
      case "paused_for_review":
        return `Plan ready for review: ${state.plan.steps.length} step(s). Approve or modify to continue.`;
      case "paused_at_step":
        return `Paused at step ${state.currentStepIndex + 1}/${state.plan.steps.length}. Approve to continue.`;
      case "completed": {
        const totalMs = state.plan.steps.reduce(
          (sum, s) => sum + (s.result?.durationMs ?? 0),
          0,
        );
        return `Completed ${state.plan.steps.length} step(s) in ${(totalMs / 1000).toFixed(1)}s.`;
      }
      case "failed":
        return state.error ?? "Workflow failed.";
      case "timed_out":
        return state.error ?? "Workflow timed out waiting for review.";
      default:
        return `Workflow status: ${state.status}`;
    }
  }
}
