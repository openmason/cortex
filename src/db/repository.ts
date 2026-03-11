import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, desc, isNull } from "drizzle-orm";
import type { Env, WorkflowState, WorkflowPlan, ExecutionResult, ApiKeyData } from "../types";
import { workflowSessions, workflowStepExecutions, executionTraces, tenantPolicies, apiKeys } from "./schema";
import type { TenantPolicy } from "../policy/engine";

/**
 * Database Repository — persists workflow data to Neon via Hyperdrive.
 *
 * Hyperdrive provides a connection string that routes through Cloudflare's
 * edge to the Neon database with connection pooling and caching.
 *
 * This layer is non-blocking: failures here log and continue rather than
 * crashing the workflow. KV remains the source of truth for live state;
 * the DB is the durable record.
 */
export class WorkflowRepository {
  private db;

  constructor(env: Env) {
    // Hyperdrive exposes a postgres:// connectionString for edge connection pooling.
    // postgres.js (not the Neon HTTP driver) is required for Hyperdrive compatibility.
    const sql = postgres(env.HYPERDRIVE.connectionString, { prepare: false });
    this.db = drizzle(sql);
  }

  /**
   * Insert a new workflow session when a workflow starts.
   */
  async createSession(state: WorkflowState, prompt: string): Promise<void> {
    try {
      await this.db.insert(workflowSessions).values({
        id: state.workflowId,
        tenantId: state.tenantId,
        userId: state.userId,
        product: state.product,
        mode: state.mode,
        status: state.status,
        prompt,
        planJson: state.plan,
        currentStepIndex: state.currentStepIndex,
        startedAt: new Date(state.startedAt),
      });
    } catch (err) {
      console.error("[db] Failed to create session:", err);
    }
  }

  /**
   * Update a workflow session's status and metadata.
   */
  async updateSession(state: WorkflowState): Promise<void> {
    try {
      await this.db
        .update(workflowSessions)
        .set({
          status: state.status,
          planJson: state.plan,
          currentStepIndex: state.currentStepIndex,
          resumeData: state.resumeData,
          error: state.error,
          pausedAt: state.pausedAt ? new Date(state.pausedAt) : null,
          completedAt: state.completedAt ? new Date(state.completedAt) : null,
          updatedAt: new Date(),
        })
        .where(eq(workflowSessions.id, state.workflowId));
    } catch (err) {
      console.error("[db] Failed to update session:", err);
    }
  }

  /**
   * Record a step execution result.
   */
  async recordStepExecution(
    sessionId: string,
    stepOrder: number,
    skill: { id: string; slug: string; version: string; executionLayer: string },
    input: Record<string, unknown>,
    result: ExecutionResult,
  ): Promise<void> {
    try {
      await this.db.insert(workflowStepExecutions).values({
        sessionId,
        stepOrder,
        skillId: skill.id,
        skillSlug: skill.slug,
        skillVersion: skill.version,
        executionLayer: skill.executionLayer,
        status: result.success ? "completed" : "failed",
        input,
        output: result.output as Record<string, unknown>,
        error: result.error ?? null,
        durationMs: result.durationMs,
        startedAt: new Date(Date.now() - result.durationMs),
        completedAt: new Date(),
      });
    } catch (err) {
      console.error("[db] Failed to record step execution:", err);
    }
  }

  /**
   * Write a full execution trace when a workflow completes.
   * This trace is used by Forge for auto-distillation.
   */
  async writeTrace(
    state: WorkflowState,
    prompt: string,
    userModifiedPlan: boolean,
  ): Promise<void> {
    try {
      const totalDurationMs = state.plan.steps.reduce(
        (sum, s) => sum + (s.result?.durationMs ?? 0),
        0,
      );

      await this.db.insert(executionTraces).values({
        sessionId: state.workflowId,
        tenantId: state.tenantId,
        product: state.product,
        prompt,
        planJson: state.plan,
        stepsExecuted: state.plan.steps.map((s) => ({
          skill: s.skill.slug,
          version: s.skill.version,
          layer: s.skill.executionLayer,
          status: s.status,
          durationMs: s.result?.durationMs,
          success: s.result?.success,
        })),
        totalDurationMs,
        success: state.status === "completed",
        userModifiedPlan,
      });
    } catch (err) {
      console.error("[db] Failed to write trace:", err);
    }
  }

  /**
   * Mark a trace as saved-as-skill.
   */
  async markTraceAsSaved(sessionId: string, skillId: string): Promise<void> {
    try {
      await this.db
        .update(executionTraces)
        .set({
          savedAsSkill: true,
          savedSkillId: skillId,
        })
        .where(eq(executionTraces.sessionId, sessionId));
    } catch (err) {
      console.error("[db] Failed to mark trace as saved:", err);
    }
  }

  /**
   * Get a session by workflowId without tenant scoping.
   * Used for DB fallback when KV state has expired.
   */
  async getSessionByWorkflowId(workflowId: string) {
    try {
      const sessions = await this.db
        .select()
        .from(workflowSessions)
        .where(eq(workflowSessions.id, workflowId))
        .limit(1);

      return sessions.length > 0 ? sessions[0] : null;
    } catch (err) {
      console.error("[db] Failed to get session by workflowId:", err);
      return null;
    }
  }

  /**
   * Load a tenant policy from the database.
   * Returns null if no policy exists for this tenant+product.
   */
  async loadPolicy(tenantId: string, product: string): Promise<TenantPolicy | null> {
    try {
      const rows = await this.db
        .select()
        .from(tenantPolicies)
        .where(
          and(
            eq(tenantPolicies.tenantId, tenantId),
            eq(tenantPolicies.product, product),
          ),
        )
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        tenantId: row.tenantId,
        product: row.product,
        defaultMode: row.defaultMode,
        defaultAppetite: row.defaultAppetite,
        trustFloor: row.trustFloor,
        enableHumanReview: row.enableHumanReview ?? true,
        sensitiveCategories: (row.sensitiveCategories as string[]) ?? [],
        blockedSkillSlugs: (row.blockedSkillSlugs as string[]) ?? [],
        maxConcurrentWorkflows: row.maxConcurrentWorkflows ?? 10,
      };
    } catch (err) {
      console.error("[db] Failed to load policy:", err);
      return null;
    }
  }

  /**
   * List sessions for a tenant, with optional filters and pagination.
   */
  async listSessions(
    tenantId: string,
    filters?: { status?: string; product?: string },
    limit = 20,
    offset = 0,
  ) {
    try {
      let query = this.db
        .select({
          id: workflowSessions.id,
          tenantId: workflowSessions.tenantId,
          userId: workflowSessions.userId,
          product: workflowSessions.product,
          mode: workflowSessions.mode,
          status: workflowSessions.status,
          prompt: workflowSessions.prompt,
          currentStepIndex: workflowSessions.currentStepIndex,
          summary: workflowSessions.summary,
          error: workflowSessions.error,
          startedAt: workflowSessions.startedAt,
          completedAt: workflowSessions.completedAt,
          createdAt: workflowSessions.createdAt,
        })
        .from(workflowSessions)
        .where(eq(workflowSessions.tenantId, tenantId))
        .orderBy(desc(workflowSessions.createdAt))
        .limit(limit)
        .offset(offset);

      const rows = await query;

      // Apply filters in-memory (Drizzle dynamic where chaining is cumbersome with neon-http)
      let filtered = rows;
      if (filters?.status) {
        filtered = filtered.filter((r) => r.status === filters.status);
      }
      if (filters?.product) {
        filtered = filtered.filter((r) => r.product === filters.product);
      }

      return filtered;
    } catch (err) {
      console.error("[db] Failed to list sessions:", err);
      return [];
    }
  }

  /**
   * Get a single session with its step executions.
   */
  async getSessionDetail(sessionId: string, tenantId: string) {
    try {
      const sessions = await this.db
        .select()
        .from(workflowSessions)
        .where(
          and(
            eq(workflowSessions.id, sessionId),
            eq(workflowSessions.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (sessions.length === 0) return null;

      const steps = await this.db
        .select()
        .from(workflowStepExecutions)
        .where(eq(workflowStepExecutions.sessionId, sessionId))
        .orderBy(workflowStepExecutions.stepOrder);

      return {
        ...sessions[0],
        steps,
      };
    } catch (err) {
      console.error("[db] Failed to get session detail:", err);
      return null;
    }
  }

  /**
   * Get the execution trace for a session.
   */
  async getSessionTrace(sessionId: string, tenantId: string) {
    try {
      const traces = await this.db
        .select()
        .from(executionTraces)
        .where(
          and(
            eq(executionTraces.sessionId, sessionId),
            eq(executionTraces.tenantId, tenantId),
          ),
        )
        .limit(1);

      return traces.length > 0 ? traces[0] : null;
    } catch (err) {
      console.error("[db] Failed to get session trace:", err);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // API Keys
  // -----------------------------------------------------------------------

  /**
   * Insert a new API key.
   */
  async createApiKey(key: string, data: ApiKeyData): Promise<void> {
    try {
      await this.db.insert(apiKeys).values({
        key,
        tenantId: data.tenantId,
        userId: data.userId,
        product: data.product,
        scopes: data.scopes,
        createdAt: new Date(data.createdAt),
      });
    } catch (err) {
      console.error("[db] Failed to create API key:", err);
      throw err;
    }
  }

  /**
   * Look up an API key. Returns null if not found or revoked.
   */
  async getApiKey(key: string): Promise<ApiKeyData | null> {
    try {
      const rows = await this.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.key, key), isNull(apiKeys.revokedAt)))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        tenantId: row.tenantId,
        userId: row.userId,
        product: row.product as ApiKeyData["product"],
        scopes: row.scopes as string[],
        createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
      };
    } catch (err) {
      console.error("[db] Failed to get API key:", err);
      return null;
    }
  }

  /**
   * Soft-revoke an API key by setting revokedAt.
   */
  async revokeApiKey(key: string): Promise<void> {
    try {
      await this.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.key, key));
    } catch (err) {
      console.error("[db] Failed to revoke API key:", err);
      throw err;
    }
  }

  /**
   * Insert or update a tenant policy.
   */
  async upsertPolicy(policy: TenantPolicy): Promise<void> {
    try {
      // Check if exists
      const existing = await this.db
        .select({ id: tenantPolicies.id })
        .from(tenantPolicies)
        .where(
          and(
            eq(tenantPolicies.tenantId, policy.tenantId),
            eq(tenantPolicies.product, policy.product),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await this.db
          .update(tenantPolicies)
          .set({
            defaultMode: policy.defaultMode,
            defaultAppetite: policy.defaultAppetite,
            trustFloor: policy.trustFloor,
            enableHumanReview: policy.enableHumanReview,
            sensitiveCategories: policy.sensitiveCategories,
            blockedSkillSlugs: policy.blockedSkillSlugs,
            maxConcurrentWorkflows: policy.maxConcurrentWorkflows,
            updatedAt: new Date(),
          })
          .where(eq(tenantPolicies.id, existing[0].id));
      } else {
        await this.db.insert(tenantPolicies).values({
          tenantId: policy.tenantId,
          product: policy.product,
          defaultMode: policy.defaultMode,
          defaultAppetite: policy.defaultAppetite,
          trustFloor: policy.trustFloor,
          enableHumanReview: policy.enableHumanReview,
          sensitiveCategories: policy.sensitiveCategories,
          blockedSkillSlugs: policy.blockedSkillSlugs,
          maxConcurrentWorkflows: policy.maxConcurrentWorkflows,
        });
      }
    } catch (err) {
      console.error("[db] Failed to upsert policy:", err);
    }
  }
}
