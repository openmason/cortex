import type { ProductConfig } from "../types";

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
    systemPrompt: `You are Bombastic, a personal AI assistant. You help users accomplish tasks by discovering and using skills from the Cortex registry.

Use findSkill to discover capabilities. When you find relevant skills, execute them to complete the user's request. Be helpful, concise, and proactive.

You have access to:
- findSkill: Search for skills by natural language description
- invokeSkill: Execute a discovered skill
- Memory from previous conversations`,
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
