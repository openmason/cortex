import type { ToolDefinition } from "../clients/llm";
import type { Env, FindSkillResponse, SkillReference, TenantContext } from "../types";
import { RunicsClient } from "../clients/runics";
import { CogniumClient } from "../clients/cognium";
import { PolicyEngine } from "../policy/engine";
import { ExecutionRouter } from "../execution/router";

// ---------------------------------------------------------------------------
// Tool Definitions — JSON Schema for the LLM
// ---------------------------------------------------------------------------

export const TOOL_FIND_SKILL: ToolDefinition = {
  type: "function",
  function: {
    name: "findSkill",
    description:
      "Search the Cortex skill registry (Runics) for skills matching a natural language query. " +
      "Returns matching skills with trust scores and execution layers.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what you want the skill to do",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter tags (e.g. 'security', 'git', 'linting')",
        },
        category: {
          type: "string",
          description: "Optional category filter",
        },
      },
      required: ["query"],
    },
  },
};

export const TOOL_CHECK_POLICY: ToolDefinition = {
  type: "function",
  function: {
    name: "checkPolicy",
    description:
      "Check whether a skill is allowed by the tenant's policy. " +
      "Returns whether the skill is allowed, requires review, or is blocked. " +
      "Use this before invoking skills in CoStaff or ControlCenter products.",
    parameters: {
      type: "object",
      properties: {
        skillSlug: {
          type: "string",
          description: "The slug of the skill to check",
        },
        skillTrustScore: {
          type: "number",
          description: "The trust score of the skill",
        },
        capabilitiesRequired: {
          type: "array",
          items: { type: "string" },
          description: "Capabilities the skill requires (e.g. 'filesystem', 'git', 'browser')",
        },
      },
      required: ["skillSlug", "skillTrustScore"],
    },
  },
};

export const TOOL_BUILD_PLAN: ToolDefinition = {
  type: "function",
  function: {
    name: "buildPlan",
    description:
      "Build a workflow execution plan from a list of skill IDs. " +
      "The plan defines the order of execution, error handling per step, " +
      "and input mappings between steps. Call this after selecting skills with findSkill.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skillId: {
                type: "string",
                description: "ID of the skill to execute in this step",
              },
              skillSlug: {
                type: "string",
                description: "Slug of the skill",
              },
              inputMapping: {
                type: "object",
                description:
                  "Input parameters for the skill. Use '$prev' to reference the output of the previous step, " +
                  "or '$step.N' for a specific step index.",
              },
              onError: {
                type: "string",
                enum: ["fail", "skip", "retry"],
                description: "What to do if this step fails. Default: 'fail'",
              },
            },
            required: ["skillId", "skillSlug"],
          },
          description: "Ordered list of steps to execute",
        },
        reasoning: {
          type: "string",
          description: "Brief explanation of why this plan achieves the user's goal",
        },
      },
      required: ["steps", "reasoning"],
    },
  },
};

export const TOOL_INVOKE_SKILL: ToolDefinition = {
  type: "function",
  function: {
    name: "invokeSkill",
    description:
      "Execute a single skill immediately and return its result. " +
      "Use this for simple, single-skill requests where a full plan isn't needed.",
    parameters: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "ID of the skill to invoke",
        },
        skillSlug: {
          type: "string",
          description: "Slug of the skill to invoke",
        },
        input: {
          type: "object",
          description: "Input parameters for the skill",
        },
      },
      required: ["skillId", "skillSlug", "input"],
    },
  },
};

// ---------------------------------------------------------------------------
// Tool Sets — which tools each product gets
// ---------------------------------------------------------------------------

export function getToolsForProduct(product: string): ToolDefinition[] {
  switch (product) {
    case "bombastic":
      return [TOOL_FIND_SKILL, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL];
    case "costaff":
      return [TOOL_FIND_SKILL, TOOL_CHECK_POLICY, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL];
    case "controlcenter":
      return [TOOL_FIND_SKILL, TOOL_CHECK_POLICY, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL];
    default:
      return [TOOL_FIND_SKILL, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL];
  }
}

// ---------------------------------------------------------------------------
// Tool Executor — wires tool calls to actual implementations
// ---------------------------------------------------------------------------

export class ToolExecutor {
  private runics: RunicsClient;
  private cognium: CogniumClient;
  private policyEngine: PolicyEngine;
  private executionRouter: ExecutionRouter;

  /** Skills discovered during this session, keyed by ID */
  private discoveredSkills = new Map<string, SkillReference>();

  /** Results from invoked skills, keyed by step index */
  private stepResults = new Map<number, unknown>();

  constructor(
    private env: Env,
    private tenant: TenantContext,
  ) {
    this.runics = new RunicsClient(env);
    this.cognium = new CogniumClient(env);
    this.policyEngine = new PolicyEngine(env);
    this.executionRouter = new ExecutionRouter(env);
  }

  /**
   * Execute a tool call by name. This is passed to LLMClient.agentLoop.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    executionCtx?: ExecutionContext,
  ): Promise<unknown> {
    switch (name) {
      case "findSkill":
        return this.handleFindSkill(args);
      case "checkPolicy":
        return this.handleCheckPolicy(args);
      case "buildPlan":
        return this.handleBuildPlan(args);
      case "invokeSkill":
        return this.handleInvokeSkill(args, executionCtx);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  /**
   * Get all skills discovered during this session.
   */
  getDiscoveredSkills(): Map<string, SkillReference> {
    return this.discoveredSkills;
  }

  // -----------------------------------------------------------------------
  // Tool Handlers
  // -----------------------------------------------------------------------

  private async handleFindSkill(args: Record<string, unknown>): Promise<unknown> {
    let response: FindSkillResponse;
    try {
      response = await this.runics.findSkill({
        query: args.query as string,
        tenantId: this.tenant.tenantId,
        appetite: this.tenant.appetite,
        tags: args.tags as string[] | undefined,
        category: args.category as string | undefined,
      });
    } catch (err) {
      return { error: `Runics search failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Cache discovered skills for later use
    for (const skill of response.results) {
      // Derive r2BundleKey for worker/container skills (convention: skills/{slug}/{version}/bundle.js)
      if ((skill.executionLayer === "worker" || skill.executionLayer === "container") && !skill.r2BundleKey) {
        skill.r2BundleKey = `skills/${skill.slug}/${skill.version}/bundle.js`;
      }
      this.discoveredSkills.set(skill.id, skill);
    }

    return {
      results: response.results.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        version: s.version,
        executionLayer: s.executionLayer,
        trustScore: s.trustScore,
        verificationTier: s.verificationTier,
        status: s.status,
        skillType: s.skillType,
        runCount: s.runCount,
        description: (s as Record<string, unknown>).agentSummary ?? undefined,
      })),
      confidence: response.confidence,
      composition: response.composition,
    };
  }

  private async handleCheckPolicy(args: Record<string, unknown>): Promise<unknown> {
    const policy = await this.policyEngine.loadPolicy(this.tenant.tenantId, this.tenant.product);
    const skill: SkillReference = {
      id: "",
      slug: args.skillSlug as string,
      version: "",
      name: "",
      executionLayer: "worker",
      trustScore: args.skillTrustScore as number,
      verificationTier: "unverified",
      trustBadge: null,
      status: "published",
      skillType: "atomic",
      runCount: 0,
      capabilitiesRequired: args.capabilitiesRequired as string[] | undefined,
    };

    const result = this.policyEngine.checkSkill(skill, policy);
    return {
      allowed: result.allowed,
      requiresReview: result.requiresReview,
      violations: result.violations.map((v) => ({
        type: v.type,
        message: v.message,
      })),
    };
  }

  private async handleBuildPlan(args: Record<string, unknown>): Promise<unknown> {
    const steps = args.steps as Array<{
      skillId: string;
      skillSlug: string;
      inputMapping?: Record<string, unknown>;
      onError?: string;
    }>;

    const planSteps = steps.map((s, i) => {
      const skill = this.discoveredSkills.get(s.skillId);
      return {
        id: crypto.randomUUID(),
        order: i,
        skillId: s.skillId,
        skillSlug: s.skillSlug,
        skillFound: !!skill,
        executionLayer: skill?.executionLayer ?? "unknown",
        trustScore: skill?.trustScore ?? 0,
        inputMapping: s.inputMapping ?? {},
        onError: s.onError ?? "fail",
      };
    });

    return {
      planId: crypto.randomUUID(),
      steps: planSteps,
      reasoning: args.reasoning as string,
      stepCount: planSteps.length,
      allSkillsFound: planSteps.every((s) => s.skillFound),
    };
  }

  private async handleInvokeSkill(
    args: Record<string, unknown>,
    executionCtx?: ExecutionContext,
  ): Promise<unknown> {
    const skillId = args.skillId as string;
    const skill = this.discoveredSkills.get(skillId);

    if (!skill) {
      return {
        error: `Skill ${skillId} not found. Use findSkill first to discover available skills.`,
      };
    }

    // Trust check
    const trustCheck = this.cognium.checkTrust(skill, this.tenant.appetite);
    if (trustCheck.blocked) {
      return {
        error: `Skill ${skill.slug} blocked by trust check: ${trustCheck.warning}`,
      };
    }

    const ctx = executionCtx ?? { waitUntil: () => {} } as unknown as ExecutionContext;
    const result = await this.executionRouter.execute(
      skill,
      (args.input as Record<string, unknown>) ?? {},
      ctx,
    );

    return {
      success: result.success,
      output: result.output,
      layer: result.layer,
      durationMs: result.durationMs,
      error: result.error,
    };
  }
}
