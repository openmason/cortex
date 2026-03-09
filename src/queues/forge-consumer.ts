import type { Env, WorkflowPlan } from "../types";
import { LLMClient, MODELS } from "../clients/llm";
import { RunicsClient } from "../clients/runics";

/**
 * Forge Queue Consumer — processes skill generation and distillation jobs.
 *
 * Message types:
 *
 *   auto-distill  — Analyze a completed workflow trace and decide whether
 *                   to distill it into a reusable composite skill.
 *   generate      — Generate a new skill definition from an intent description
 *                   (used when no matching skill is found).
 */

interface AutoDistillPayload {
  type: "auto-distill";
  traceId: string;
  tenantId: string;
  prompt: string;
  plan: WorkflowPlan;
  timestamp: number;
}

interface GeneratePayload {
  type: "generate";
  intent: string;
  capabilities: string[];
  timestamp: number;
}

type ForgePayload = AutoDistillPayload | GeneratePayload;

export async function handleForgeMessage(
  payload: ForgePayload,
  env: Env,
): Promise<void> {
  switch (payload.type) {
    case "auto-distill":
      return handleAutoDistill(payload, env);
    case "generate":
      return handleGenerate(payload, env);
    default:
      console.warn(`[forge] Unknown message type: ${(payload as any).type}`);
  }
}

/**
 * Auto-distill: Evaluate whether a completed workflow should be
 * saved as a reusable composite skill.
 *
 * Criteria:
 * - Multi-step workflow (2+ steps)
 * - All steps completed successfully
 * - Pattern hasn't already been distilled
 *
 * If the LLM determines this is a reusable pattern, it generates
 * a skill definition and publishes it to Runics.
 */
async function handleAutoDistill(
  payload: AutoDistillPayload,
  env: Env,
): Promise<void> {
  console.log(`[forge] Auto-distill: trace=${payload.traceId}, steps=${payload.plan.steps.length}`);

  // Only consider multi-step workflows for distillation
  if (payload.plan.steps.length < 2) {
    console.log(`[forge] Skipping single-step workflow`);
    return;
  }

  // Check all steps completed
  const allCompleted = payload.plan.steps.every((s) => s.status === "completed");
  if (!allCompleted) {
    console.log(`[forge] Skipping: not all steps completed`);
    return;
  }

  const llm = new LLMClient(env);
  const runics = new RunicsClient(env);

  // Ask the LLM to evaluate the workflow for distillation
  const stepsDescription = payload.plan.steps
    .map((s, i) => `${i + 1}. ${s.skill.name} (${s.skill.slug}) — ${s.skill.executionLayer}`)
    .join("\n");

  const response = await llm.chat({
    model: MODELS.CLAUDE_HAIKU,
    messages: [
      {
        role: "system",
        content: `You evaluate completed workflows to determine if they should be saved as reusable composite skills. Respond with JSON only.`,
      },
      {
        role: "user",
        content: `A workflow with these steps completed successfully:

${stepsDescription}

Original prompt: "${payload.prompt}"

Should this be distilled into a reusable composite skill? Consider:
- Is this a common pattern others would use?
- Are the steps logically connected?
- Would it save time to have this as a single skill?

Respond with JSON:
{
  "shouldDistill": boolean,
  "suggestedName": "string",
  "suggestedSlug": "string",
  "suggestedDescription": "string",
  "reasoning": "string"
}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 500,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return;

  try {
    const evaluation = JSON.parse(content);

    if (!evaluation.shouldDistill) {
      console.log(`[forge] LLM decided not to distill: ${evaluation.reasoning}`);
      return;
    }

    // Publish the composite skill to Runics
    const compositionSkillIds = payload.plan.steps.map((s) => s.skill.id);

    const res = await fetch(`${env.RUNICS_URL}/v1/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: evaluation.suggestedName,
        slug: evaluation.suggestedSlug,
        description: evaluation.suggestedDescription,
        executionLayer: "composite",
        source: "auto-distilled",
        skillType: "auto-composite",
        compositionSkillIds,
        trustBadge: "auto-distilled",
        tenantId: payload.tenantId,
      }),
    });

    if (res.ok) {
      const result = await res.json() as { skillId: string; slug: string };
      console.log(`[forge] Auto-distilled skill: ${result.slug} (${result.skillId})`);
    } else {
      console.error(`[forge] Failed to publish auto-distilled skill: ${res.status}`);
    }
  } catch (err) {
    console.error(`[forge] Auto-distill evaluation failed:`, err);
  }
}

/**
 * Generate: Create a new skill definition when no matching skill
 * is found in the registry. The LLM generates a SKILL.md and
 * execution metadata.
 */
async function handleGenerate(
  payload: GeneratePayload,
  env: Env,
): Promise<void> {
  console.log(`[forge] Generate skill for intent: "${payload.intent}"`);

  const llm = new LLMClient(env);

  const response = await llm.chat({
    model: MODELS.CLAUDE_SONNET,
    messages: [
      {
        role: "system",
        content: `You generate skill definitions for the Cortex skill registry. Output JSON only.`,
      },
      {
        role: "user",
        content: `Generate a skill definition for:
Intent: "${payload.intent}"
Required capabilities: ${payload.capabilities.join(", ") || "none"}

Respond with JSON:
{
  "name": "Human-readable skill name",
  "slug": "kebab-case-slug",
  "description": "What this skill does",
  "executionLayer": "worker" | "container" | "instructions",
  "skillMd": "# Skill Instructions\\n\\nStep-by-step instructions for the LLM...",
  "capabilitiesRequired": ["list", "of", "capabilities"],
  "schemaJson": { "input": {}, "output": {} }
}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return;

  try {
    const skillDef = JSON.parse(content);

    // Publish as draft skill to Runics
    const res = await fetch(`${env.RUNICS_URL}/v1/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...skillDef,
        source: "forge-generated",
        skillType: "atomic",
        status: "draft",
        trustBadge: null,
      }),
    });

    if (res.ok) {
      const result = await res.json() as { skillId: string; slug: string };
      console.log(`[forge] Generated skill: ${result.slug} (${result.skillId})`);
    } else {
      console.error(`[forge] Failed to publish generated skill: ${res.status}`);
    }
  } catch (err) {
    console.error(`[forge] Skill generation failed:`, err);
  }
}
