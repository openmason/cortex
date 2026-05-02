/**
 * CF Workflows POC — Durable skill execution with automatic retries/checkpointing.
 *
 * This module provides a Cloudflare Workflows implementation for executing
 * individual skills with durable state persistence. Unlike the DAGWorkflowEngine
 * which manages state manually via KV, CF Workflows handles checkpointing
 * automatically at each step.do() boundary.
 *
 * Usage:
 * - Bind in wrangler.toml: [[workflows]] name="skill-workflow" binding="SKILL_WORKFLOW" class_name="SkillWorkflow"
 * - Trigger: env.SKILL_WORKFLOW.create({ params: { skillSlug, input, tenantId } })
 * - Query status: env.SKILL_WORKFLOW.get(instanceId).status()
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, SkillReference, ExecutionResult, ExecutionLayer } from "../types";
import { RunicsClient } from "../clients/runics";
import { ExecutionRouter } from "../execution/router";
import { LLMClient } from "../clients/llm";
import { Logger } from "../observability/logger";

export interface SkillWorkflowParams {
  /** Skill slug (e.g., "@runics/git-clone@1.0.0" or just "git-clone") */
  skillSlug: string;
  /** Skill version (defaults to "latest") */
  skillVersion?: string;
  /** Input parameters for the skill */
  input: Record<string, unknown>;
  /** Tenant ID for authorization */
  tenantId: string;
  /** Optional request ID for tracing */
  requestId?: string;
}

export interface SkillWorkflowResult {
  skillSlug: string;
  skillId: string;
  success: boolean;
  output: unknown;
  durationMs: number;
  error?: string;
}

/** Serializable skill info returned from resolve step */
interface SerializedSkill {
  id: string;
  slug: string;
  version: string;
  name: string;
  executionLayer: ExecutionLayer;
  mcpUrl?: string;
  skillMd?: string;
  r2BundleKey?: string;
}

/** Serializable execution result returned from execute step */
interface SerializedResult {
  success: boolean;
  /** Output serialized to JSON string to ensure serializability */
  outputJson: string;
  durationMs: number;
  layer: string;
  error?: string;
}

/**
 * SkillWorkflow — CF Workflow for executing a single skill with durability.
 *
 * Features:
 * - Automatic checkpointing after each step
 * - Configurable retries with exponential backoff
 * - Automatic state recovery on worker restart
 * - Queryable status via Workflows API
 */
export class SkillWorkflow extends WorkflowEntrypoint<Env, SkillWorkflowParams> {
  async run(
    event: WorkflowEvent<SkillWorkflowParams>,
    step: WorkflowStep,
  ): Promise<SkillWorkflowResult> {
    const { skillSlug, skillVersion, input, tenantId, requestId } = event.payload;
    const log = new Logger("cf-workflow", { requestId, workflowInstanceId: event.instanceId });
    const startTime = Date.now();

    log.info("Starting skill workflow", { skillSlug, skillVersion, tenantId });

    // Step 1: Resolve skill from Runics
    // Returns a serializable subset of SkillReference
    const skill = await step.do<SerializedSkill>(
      "resolve-skill",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "30 seconds",
      },
      async () => {
        const runics = new RunicsClient(this.env);
        const resolved = await runics.getSkill(skillSlug, skillVersion ?? "latest");
        if (!resolved) {
          throw new Error(`Skill not found: ${skillSlug}@${skillVersion ?? "latest"}`);
        }
        // Return only serializable fields needed for execution
        return {
          id: resolved.id,
          slug: resolved.slug,
          version: resolved.version,
          name: resolved.name,
          executionLayer: resolved.executionLayer,
          mcpUrl: resolved.mcpUrl,
          skillMd: resolved.skillMd,
          r2BundleKey: resolved.r2BundleKey,
        };
      },
    );

    log.info("Skill resolved", { skillId: skill.id, slug: skill.slug, version: skill.version });

    // Step 2: Execute skill via ExecutionRouter
    // Returns a serializable result (output serialized to JSON string)
    const result = await step.do<SerializedResult>(
      "execute-skill",
      {
        retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      },
      async () => {
        const llm = new LLMClient(this.env, log);
        const router = new ExecutionRouter(this.env, llm, log);
        // Reconstruct a minimal SkillReference for the router
        const skillRef: SkillReference = {
          ...skill,
          trustScore: 0.5,
          verificationTier: "unverified",
          trustBadge: null,
          status: "published",
          skillType: "atomic",
          runCount: 0,
        };
        const execResult = await router.execute(skillRef, input);
        return {
          success: execResult.success,
          outputJson: JSON.stringify(execResult.output ?? null),
          durationMs: execResult.durationMs,
          layer: execResult.layer,
          error: execResult.error,
        };
      },
    );

    const durationMs = Date.now() - startTime;

    // Parse the output back from JSON
    let output: unknown;
    try {
      output = JSON.parse(result.outputJson);
    } catch {
      output = result.outputJson;
    }

    if (result.success) {
      log.info("Skill workflow completed", { skillSlug, durationMs });
    } else {
      log.warn("Skill workflow failed", { skillSlug, error: result.error, durationMs });
    }

    return {
      skillSlug: skill.slug,
      skillId: skill.id,
      success: result.success,
      output,
      durationMs,
      error: result.error,
    };
  }
}

/**
 * DAGWorkflow — CF Workflow for executing a DAG with parallel layer support.
 *
 * This is a more advanced workflow that executes DAG steps layer by layer,
 * with each layer being a durable step. Steps within a layer run in parallel
 * but the parallel execution happens within a single step.do() call.
 *
 * TODO: Implement after SkillWorkflow POC is validated
 */
// export class DAGWorkflow extends WorkflowEntrypoint<Env, DAGWorkflowParams> { ... }
