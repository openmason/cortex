import type { Env, DistillRequest, WorkflowState, Visibility } from "../types";

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
   * This calls the Forge human-distill endpoint directly (synchronous).
   */
  async humanDistill(request: {
    name: string;
    description: string;
    workflowState: WorkflowState;
    userId: string;
    visibility: Visibility;
  }): Promise<{ skillId: string; slug: string }> {
    // Build the composition skill IDs from the workflow steps
    const compositionSkillIds = request.workflowState.plan.steps.map(
      (s) => s.skill.id,
    );

    const steps = request.workflowState.plan.steps.map((s, i) => ({
      skillId: s.skill.id,
      stepName: s.skill.name,
      stepOrder: i,
      inputMapping: s.inputMapping,
      onError: s.onError,
    }));

    // Publish directly to Runics as a human-composite skill
    const res = await fetch(`${this.env.RUNICS_URL}/v1/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: request.name,
        slug: slugify(request.name),
        description: request.description,
        executionLayer: "composite",
        source: "human-distilled",
        skillType: "human-composite",
        compositionSkillIds,
        humanDistilledBy: request.userId,
        trustBadge: "human-verified",
        tenantId:
          request.visibility === "public"
            ? undefined
            : request.workflowState.tenantId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Forge human-distill failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
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
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
