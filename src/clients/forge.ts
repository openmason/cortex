import type { Env, WorkflowState, WorkflowStep, Visibility, SaveAsSkillResponse } from "../types";
import { LLMClient, MODELS } from "./llm";

/**
 * Forge Client — skill generation and distillation triggers.
 *
 * Mode 1: Generate-before — LLM generates a new skill when no match found
 * Mode 2: Auto-distill   — post-workflow hook evaluates traces for reusable patterns
 * Mode 3: Human-distill  — user saves a modified workflow as a named skill
 */
export class ForgeClient {
  constructor(private env: Env) {}

  /**
   * Mode 2: Auto-distill — enqueue a completed workflow trace for
   * automatic pattern detection and skill distillation.
   */
  async autoDistill(workflowState: WorkflowState): Promise<void> {
    await this.env.FORGE_QUEUE.send({
      type: "auto-distill",
      traceId: workflowState.workflowId,
      tenantId: workflowState.tenantId,
      prompt: workflowState.plan.steps.map((s) => s.skill.slug).join(" → "),
      plan: workflowState.plan,
      timestamp: Date.now(),
    });
  }

  /**
   * Mode 3: Human-distill — user explicitly saves a workflow as a skill.
   * Publishes directly to Runics with composite trust, alt-queries, and step definitions.
   */
  async humanDistill(request: {
    name: string;
    description: string;
    workflowState: WorkflowState;
    userId: string;
    visibility: Visibility;
    tags?: string[];
    category?: string;
  }): Promise<SaveAsSkillResponse> {
    const steps = request.workflowState.plan.steps;
    const compositionSkillIds = steps.map((s) => s.skill.id);

    // Compute composite trust: min(sub-skills) × 0.9 + 0.05 (human-verified bonus)
    const trustScore = computeCompositeTrust(steps);

    // Generate alt-queries for Runics semantic search
    const altQueries = await this.generateAltQueries(
      request.name,
      request.description,
      steps.map((s) => s.skill.name),
    );

    // Build step definitions for Runics to expand composites later
    const stepDefinitions = steps.map((s, i) => ({
      skillId: s.skill.id,
      skillSlug: s.skill.slug,
      skillVersion: s.skill.version,
      stepName: s.skill.name,
      stepOrder: i,
      inputMapping: s.inputMapping,
      onError: s.onError,
    }));

    // Derive input/output schema from constituent steps
    const schemaJson = deriveCompositeSchema(steps);

    const slug = slugify(request.name);
    const version = "1.0.0";

    // Publish to Runics
    const res = await fetch(`${this.env.RUNICS_URL}/v1/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: request.name,
        slug,
        version,
        description: request.description,
        altQueries,
        executionLayer: "composite",
        source: "human-distilled",
        skillType: "human-composite",
        compositionSkillIds,
        steps: stepDefinitions,
        schemaJson,
        humanDistilledBy: request.userId,
        trustBadge: "human-verified",
        trustScore,
        tags: request.tags ?? [],
        category: request.category,
        tenantId:
          request.visibility === "public"
            ? undefined
            : request.workflowState.tenantId,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to publish skill to Runics: ${res.status} ${text}`);
    }

    const created = (await res.json()) as { id: string; slug: string };

    return {
      skillId: created.id,
      slug,
      name: request.name,
      version,
      trustScore,
      composedFrom: steps.map((s) => ({
        skillId: s.skill.id,
        slug: s.skill.slug,
        version: s.skill.version,
        trustScore: s.skill.trustScore,
      })),
      visibility: request.visibility,
      executionLayer: "composite",
      skillType: "human-composite",
      trustBadge: "human-verified",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Mode 1: Generate-before — when no skill match is found, ask the LLM
   * to generate a new skill definition on the fly.
   */
  async generateSkill(intent: string, capabilities: string[]): Promise<void> {
    await this.env.FORGE_QUEUE.send({
      type: "generate",
      intent,
      capabilities,
      timestamp: Date.now(),
    });
  }

  /**
   * Generate 3-5 alternative search queries for Runics embedding.
   * Falls back to simple heuristics if the LLM call fails.
   */
  private async generateAltQueries(
    name: string,
    description: string,
    stepNames: string[],
  ): Promise<string[]> {
    try {
      const llm = new LLMClient(this.env);

      const response = await llm.chat({
        model: MODELS.CLAUDE_HAIKU,
        messages: [
          {
            role: "system",
            content: "You generate alternative search queries for a skill registry. Return ONLY a JSON array of 3-5 strings.",
          },
          {
            role: "user",
            content: `Generate 3-5 alternative search queries users might use to find this composite skill:\n\nName: ${name}\nDescription: ${description}\nSteps: ${stepNames.join(", ")}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return this.fallbackAltQueries(name, description, stepNames);

      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed.slice(0, 5);

      return this.fallbackAltQueries(name, description, stepNames);
    } catch {
      return this.fallbackAltQueries(name, description, stepNames);
    }
  }

  private fallbackAltQueries(name: string, description: string, stepNames: string[]): string[] {
    const queries: string[] = [name.toLowerCase()];
    const firstSentence = description.split(".")[0]?.trim();
    if (firstSentence) queries.push(firstSentence.toLowerCase());
    if (stepNames.length > 0) queries.push(stepNames.join(" and ").toLowerCase());
    return queries;
  }
}

/**
 * Compute composite trust score.
 * Formula: min(constituent trusts) × 0.9 + 0.05 (human-verified bonus)
 * Clamped to [0.3, 1.0]
 */
export function computeCompositeTrust(steps: WorkflowStep[]): number {
  if (steps.length === 0) return 0.5;

  const minTrust = Math.min(...steps.map((s) => s.skill.trustScore));
  const raw = minTrust * 0.9 + 0.05;

  return Math.round(Math.max(0.3, Math.min(1.0, raw)) * 100) / 100;
}

/**
 * Derive a composite input/output schema from the first and last steps.
 */
export function deriveCompositeSchema(steps: WorkflowStep[]): Record<string, unknown> {
  if (steps.length === 0) return { input: { type: "object" }, output: { type: "object" } };

  const first = steps[0];
  const last = steps[steps.length - 1];

  return {
    input: (first.skill.schemaJson as Record<string, unknown> | undefined)?.input ?? { type: "object" },
    output: (last.skill.schemaJson as Record<string, unknown> | undefined)?.output ?? { type: "object" },
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
