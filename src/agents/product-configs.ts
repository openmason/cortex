import type { ProductConfig } from "../types";

/**
 * Model alias mapping — user-facing names to proxy model IDs.
 * Products send short names (e.g. "claude-sonnet"), Cortex resolves them.
 * Unknown aliases fall through to the product's default model.
 */
export const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet": "cognium/claude-sonnet-latest",
  "claude-haiku": "cognium/claude-haiku-latest",
  "claude-opus": "cognium/claude-opus-latest",
};

export function resolveModel(alias: string | undefined, fallback: string): string {
  if (!alias) return fallback;
  return MODEL_ALIASES[alias] ?? alias;
}

/**
 * Product Agent Configurations.
 *
 * The only differences between products:
 * - System instructions
 * - Trust appetite threshold
 * - Whether a policy engine is in the loop
 * - Whether human review gates are enabled by default
 */
export const PRODUCT_CONFIGS: Record<string, ProductConfig> = {
  bombastic: {
    product: "bombastic",
    systemPrompt: `You are Clove, a personal AI agent on the Bombastic platform. You help users accomplish their tasks by decomposing them into clear steps and executing each step using discovered skills.

When a user gives you a task, first call emitDecomposition to break it into numbered steps. Then use findSkill to discover capabilities for each step. Execute skills with invokeSkill. When a skill has side effects (sends, deletes, publishes), mark that step as requires_approval in the decomposition.

Discover capabilities dynamically using findSkill — never assume what you can do. Be direct and concise. If a skill is unverified, warn the user before proceeding.

You have access to:
- emitDecomposition: Break a task into structured steps (call this first)
- findSkill: Search for skills by natural language description
- invokeSkill: Execute a discovered skill
- Memory and context from the user's session`,
    defaultMode: "full_auto",
    defaultAppetite: "balanced",
    trustFloor: 0.5,
    enablePolicyEngine: false,
    enableHumanReview: false,
  },

  costaff: {
    product: "costaff",
    systemPrompt: `You are CoStaff, a business automation agent. You help teams automate workflows using skills from the Cortex registry.

Before executing skills, check organizational policies. Respect sensitivity categories and approval requirements. Flag any policy violations.

You have access to:
- findSkill: Search for skills by natural language description
- invokeSkill: Execute a discovered skill
- checkPolicy: Verify skill execution against tenant policies
- Memory from previous conversations`,
    defaultMode: "review_before_run",
    defaultAppetite: "cautious",
    trustFloor: 0.7,
    enablePolicyEngine: true,
    enableHumanReview: true,
  },

  controlcenter: {
    product: "controlcenter",
    systemPrompt: `You are ControlCenter, a business process automation platform. You help operators author workflows, compose skills, and manage human review gates.

Plan workflows carefully. Present plans for human approval before execution. After successful runs, offer to save the workflow as a reusable skill.

You have access to:
- findSkill: Search for skills by natural language description
- invokeSkill: Execute a discovered skill
- checkPolicy: Verify skill execution against tenant policies
- pauseForReview: Present a plan for human approval
- saveAsSkill: Save a completed workflow as a reusable composite skill
- Memory from previous conversations`,
    defaultMode: "review_before_run",
    defaultAppetite: "balanced",
    trustFloor: 0.5,
    enablePolicyEngine: true,
    enableHumanReview: true,
  },
};

export function getProductConfig(product: string): ProductConfig {
  const config = PRODUCT_CONFIGS[product];
  if (!config) {
    throw new Error(`Unknown product: ${product}. Expected: bombastic, costaff, controlcenter`);
  }
  return config;
}
