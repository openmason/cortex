import type { ToolDefinition } from "../clients/llm";
import type { LLMClient } from "../clients/llm";
import type { Env, FindSkillResponse, SkillReference, TenantContext, OnStreamEvent } from "../types";
import { RunicsClient } from "../clients/runics";
import { CogniumClient } from "../clients/cognium";
import { PolicyEngine } from "../policy/engine";
import { ExecutionRouter } from "../execution/router";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

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
                type: "string",
                description:
                  "JSON string of input parameters for the skill. Use '$prev' to reference the output of the previous step, " +
                  "or '$step.N' for a specific step index. Example: '{\"code\": \"$prev\"}'",
              },
              onError: {
                type: "string",
                description: "What to do if this step fails: 'fail', 'skip', or 'retry'. Default: 'fail'",
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

export const TOOL_EMIT_DECOMPOSITION: ToolDefinition = {
  type: "function",
  function: {
    name: "emitDecomposition",
    description:
      "Emit a structured task decomposition to the client. Call this when you break a user's request " +
      "into discrete steps. The client will display these steps as a checklist.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Short title of the step",
              },
              requires_approval: {
                type: "boolean",
                description: "Whether this step has side effects requiring user approval",
              },
            },
            required: ["title"],
          },
          description: "Ordered list of steps the task decomposes into",
        },
      },
      required: ["steps"],
    },
  },
};

export const TOOL_EXTRACT_MEMORY: ToolDefinition = {
  type: "function",
  function: {
    name: "extractMemory",
    description:
      "Extract and store a piece of personal information the user shared. " +
      "Call this whenever the user reveals a personal preference, fact, relationship, or context " +
      "that would be useful to remember in future conversations. Examples: name, location, " +
      "preferences, relationships, work details, habits.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["preference", "personal_fact", "relationship", "work", "location", "habit", "other"],
          description: "Category of the memory",
        },
        key: {
          type: "string",
          description: "Short key identifying what is being remembered (e.g. 'favorite_drink', 'boss_name', 'home_city')",
        },
        value: {
          type: "string",
          description: "The actual information to remember",
        },
        source: {
          type: "string",
          description: "The user's original statement that this was extracted from",
        },
      },
      required: ["category", "key", "value"],
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
          type: "string",
          description: "JSON string of input parameters for the skill. Example: '{\"query\": \"hello\"}'",
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
      return [TOOL_FIND_SKILL, TOOL_BUILD_PLAN, TOOL_INVOKE_SKILL, TOOL_EMIT_DECOMPOSITION, TOOL_EXTRACT_MEMORY];
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

  /** Track if decomposition was already emitted this session */
  private decompositionEmitted = false;

  /** Track findSkill no_match count to prevent endless searching */
  private noMatchCount = 0;

  constructor(
    private env: Env,
    private tenant: TenantContext,
    llm?: LLMClient,
    log?: Logger,
    metrics?: Metrics,
    private onEvent?: OnStreamEvent,
  ) {
    this.runics = new RunicsClient(env);
    this.cognium = new CogniumClient();
    this.policyEngine = new PolicyEngine(env);
    this.executionRouter = new ExecutionRouter(env, llm, log?.child({ module: "router" }), metrics);
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
      case "emitDecomposition":
        return this.handleEmitDecomposition(args);
      case "extractMemory":
        return this.handleExtractMemory(args);
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

  private async handleEmitDecomposition(args: Record<string, unknown>): Promise<unknown> {
    // Prevent duplicate decomposition calls - this is a common LLM mistake
    if (this.decompositionEmitted) {
      return {
        error: "Decomposition already emitted for this task. Do not call emitDecomposition again.",
        alreadyEmitted: true,
      };
    }

    const steps = (args.steps as Array<{ title: string; requires_approval?: boolean }>).map((s) => ({
      title: s.title,
      status: "pending" as const,
      requires_approval: s.requires_approval ?? false,
    }));

    // Emit decomposition data part to the client stream
    if (this.onEvent) {
      await this.onEvent({
        type: "data",
        data: [{ type: "decomposition", steps }],
      });
    }

    this.decompositionEmitted = true;
    return { emitted: true, stepCount: steps.length };
  }

  private async handleExtractMemory(args: Record<string, unknown>): Promise<unknown> {
    const memory = {
      category: args.category as string,
      key: args.key as string,
      value: args.value as string,
      source: args.source as string | undefined,
    };

    // Emit memory data part to the client stream
    if (this.onEvent) {
      await this.onEvent({
        type: "data",
        data: [{ type: "memory", ...memory }],
      });
    }

    return { stored: true, ...memory };
  }

  private async handleFindSkill(args: Record<string, unknown>): Promise<unknown> {
    // Check if we've already had too many no_match results - stop searching
    if (this.noMatchCount >= 2) {
      return {
        results: [],
        confidence: "no_match",
        stopSearching: true,
        message: "No skills found after multiple attempts. STOP calling findSkill and respond directly to the user.",
      };
    }

    let response: FindSkillResponse;
    try {
      response = await this.runics.findSkill({
        query: args.query as string,
        tenantId: this.tenant.tenantId,
        userId: this.tenant.userId,
        appetite: this.tenant.appetite,
        tags: args.tags as string[] | undefined,
        category: args.category as string | undefined,
      });
    } catch (err) {
      return { error: `Runics search failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Track no_match results
    if (response.confidence === "no_match") {
      this.noMatchCount++;
    }

    // Cache discovered skills for later use
    for (const skill of response.results) {
      // Derive r2BundleKey for worker/container skills (convention: skills/{slug}/{version}/bundle.js)
      if ((skill.executionLayer === "worker" || skill.executionLayer === "container") && !skill.r2BundleKey) {
        skill.r2BundleKey = `skills/${skill.slug}/${skill.version}/bundle.js`;
      }
      this.discoveredSkills.set(skill.id, skill);
    }

    const result: Record<string, unknown> = {
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

    // Add hint to stop searching after first no_match
    if (response.confidence === "no_match") {
      result.hint = "No matching skills found. Do NOT try different query variations. Respond to the user directly.";
    }

    return result;
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
      inputMapping?: string | Record<string, unknown>;
      onError?: string;
    }>;

    const planSteps = steps.map((s, i) => {
      const skill = this.discoveredSkills.get(s.skillId);
      // inputMapping may arrive as JSON string or object
      let mapping: Record<string, unknown> = {};
      if (typeof s.inputMapping === "string") {
        try { mapping = JSON.parse(s.inputMapping); } catch { /* keep empty */ }
      } else if (s.inputMapping) {
        mapping = s.inputMapping;
      }
      return {
        id: crypto.randomUUID(),
        order: i,
        skillId: s.skillId,
        skillSlug: s.skillSlug,
        skillFound: !!skill,
        executionLayer: skill?.executionLayer ?? "unknown",
        trustScore: skill?.trustScore ?? 0,
        inputMapping: mapping,
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

    // input may arrive as JSON string or object
    let input: Record<string, unknown> = {};
    if (typeof args.input === "string") {
      try { input = JSON.parse(args.input); } catch { /* keep empty */ }
    } else if (args.input) {
      input = args.input as Record<string, unknown>;
    }

    const ctx = executionCtx ?? { waitUntil: () => {} } as unknown as ExecutionContext;
    const result = await this.executionRouter.execute(
      skill,
      input,
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
