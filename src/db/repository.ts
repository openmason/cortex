import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, desc, isNull, like, gte, lte, type SQL } from "drizzle-orm";
import type { Env, WorkflowState, WorkflowPlan, ExecutionResult, ApiKeyData, AuditEntry, AuditQueryFilters } from "../types";
import { workflowSessions, workflowStepExecutions, executionTraces, tenantPolicies, apiKeys, auditLog } from "./schema";
import type { TenantPolicy } from "../policy/engine";
import type { Logger } from "../observability/logger";

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
  private log?: Logger;

  constructor(env: Env, log?: Logger) {
    // Hyperdrive exposes a postgres:// connectionString for edge connection pooling.
    // postgres.js (not the Neon HTTP driver) is required for Hyperdrive compatibility.
    const sql = postgres(env.HYPERDRIVE.connectionString, { prepare: false });
    this.db = drizzle(sql);
    this.log = log;
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
        conversationId: state.conversationId ?? null,
        planJson: state.plan,
        currentStepIndex: state.currentStepIndex,
        startedAt: new Date(state.startedAt),
      });
    } catch (err) {
      this.log?.error("Failed to create session", { error: err instanceof Error ? err.message : String(err), workflowId: state.workflowId });
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
      this.log?.error("Failed to update session", { error: err instanceof Error ? err.message : String(err), workflowId: state.workflowId });
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
      this.log?.error("Failed to record step execution", { error: err instanceof Error ? err.message : String(err), sessionId, stepOrder, skillSlug: skill.slug });
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
      this.log?.error("Failed to write trace", { error: err instanceof Error ? err.message : String(err), workflowId: state.workflowId });
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
      this.log?.error("Failed to mark trace as saved", { error: err instanceof Error ? err.message : String(err), sessionId, skillId });
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
      this.log?.error("Failed to get session by workflowId", { error: err instanceof Error ? err.message : String(err), workflowId });
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
      this.log?.error("Failed to load policy", { error: err instanceof Error ? err.message : String(err), tenantId, product });
      return null;
    }
  }

  /**
   * List sessions for a tenant, with optional SQL-pushed filters and pagination.
   */
  async listSessions(
    tenantId: string,
    filters?: {
      status?: string;
      product?: string;
      conversationId?: string;
      promptSearch?: string;
      from?: string;
      to?: string;
    },
    limit = 20,
    offset = 0,
  ) {
    try {
      // Build WHERE conditions dynamically
      const conditions: SQL[] = [eq(workflowSessions.tenantId, tenantId)];

      if (filters?.status) {
        conditions.push(eq(workflowSessions.status, filters.status));
      }
      if (filters?.product) {
        conditions.push(eq(workflowSessions.product, filters.product));
      }
      if (filters?.conversationId) {
        conditions.push(eq(workflowSessions.conversationId, filters.conversationId));
      }
      if (filters?.promptSearch) {
        conditions.push(like(workflowSessions.prompt, `%${filters.promptSearch}%`));
      }
      if (filters?.from) {
        conditions.push(gte(workflowSessions.createdAt, new Date(filters.from)));
      }
      if (filters?.to) {
        conditions.push(lte(workflowSessions.createdAt, new Date(filters.to)));
      }

      const rows = await this.db
        .select({
          id: workflowSessions.id,
          tenantId: workflowSessions.tenantId,
          userId: workflowSessions.userId,
          product: workflowSessions.product,
          mode: workflowSessions.mode,
          status: workflowSessions.status,
          prompt: workflowSessions.prompt,
          conversationId: workflowSessions.conversationId,
          currentStepIndex: workflowSessions.currentStepIndex,
          summary: workflowSessions.summary,
          error: workflowSessions.error,
          startedAt: workflowSessions.startedAt,
          completedAt: workflowSessions.completedAt,
          createdAt: workflowSessions.createdAt,
        })
        .from(workflowSessions)
        .where(and(...conditions))
        .orderBy(desc(workflowSessions.createdAt))
        .limit(limit)
        .offset(offset);

      return rows;
    } catch (err) {
      this.log?.error("Failed to list sessions", { error: err instanceof Error ? err.message : String(err), tenantId });
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
      this.log?.error("Failed to get session detail", { error: err instanceof Error ? err.message : String(err), sessionId, tenantId });
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
      this.log?.error("Failed to get session trace", { error: err instanceof Error ? err.message : String(err), sessionId, tenantId });
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
        source: data.source ?? "api",
        createdAt: new Date(data.createdAt),
      });
    } catch (err) {
      this.log?.error("Failed to create API key", { error: err instanceof Error ? err.message : String(err), tenantId: data.tenantId });
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
        source: (row.source as ApiKeyData["source"]) ?? "api",
        createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
      };
    } catch (err) {
      this.log?.error("Failed to get API key", { error: err instanceof Error ? err.message : String(err) });
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
      this.log?.error("Failed to revoke API key", { error: err instanceof Error ? err.message : String(err) });
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
      this.log?.error("Failed to upsert policy", { error: err instanceof Error ? err.message : String(err), tenantId: policy.tenantId, product: policy.product });
    }
  }

  // -----------------------------------------------------------------------
  // Audit Log (Mandate v0.5)
  // -----------------------------------------------------------------------

  /**
   * Write an audit log entry.
   * This is a synchronous write — audit entries are critical for compliance.
   */
  async writeAuditEntry(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        tenantId: entry.tenantId,
        userId: entry.userId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? null,
        requestId: entry.requestId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        status: entry.status,
        errorMessage: entry.errorMessage ?? null,
      });
    } catch (err) {
      // Audit write failures are logged but don't throw — we don't want to break the primary operation
      this.log?.error("Failed to write audit entry", {
        error: err instanceof Error ? err.message : String(err),
        tenantId: entry.tenantId,
        action: entry.action,
      });
    }
  }

  /**
   * Query audit log entries with filters.
   */
  async queryAuditLog(
    tenantId: string,
    filters?: AuditQueryFilters,
    limit = 50,
    offset = 0,
  ): Promise<AuditEntry[]> {
    try {
      const conditions: SQL[] = [eq(auditLog.tenantId, tenantId)];

      if (filters?.action) {
        conditions.push(eq(auditLog.action, filters.action));
      }
      if (filters?.resourceType) {
        conditions.push(eq(auditLog.resourceType, filters.resourceType));
      }
      if (filters?.resourceId) {
        conditions.push(eq(auditLog.resourceId, filters.resourceId));
      }
      if (filters?.userId) {
        conditions.push(eq(auditLog.userId, filters.userId));
      }
      if (filters?.status) {
        conditions.push(eq(auditLog.status, filters.status));
      }
      if (filters?.from) {
        conditions.push(gte(auditLog.createdAt, new Date(filters.from)));
      }
      if (filters?.to) {
        conditions.push(lte(auditLog.createdAt, new Date(filters.to)));
      }

      const rows = await this.db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset(offset);

      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId ?? undefined,
        action: row.action as AuditEntry["action"],
        resourceType: row.resourceType as AuditEntry["resourceType"],
        resourceId: row.resourceId ?? undefined,
        metadata: row.metadata as Record<string, unknown> | undefined,
        requestId: row.requestId ?? undefined,
        ipAddress: row.ipAddress ?? undefined,
        userAgent: row.userAgent ?? undefined,
        status: row.status as AuditEntry["status"],
        errorMessage: row.errorMessage ?? undefined,
        createdAt: row.createdAt?.toISOString(),
      }));
    } catch (err) {
      this.log?.error("Failed to query audit log", {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return [];
    }
  }

  /**
   * Count audit log entries matching filters.
   */
  async countAuditEntries(tenantId: string, filters?: AuditQueryFilters): Promise<number> {
    try {
      const conditions: SQL[] = [eq(auditLog.tenantId, tenantId)];

      if (filters?.action) {
        conditions.push(eq(auditLog.action, filters.action));
      }
      if (filters?.resourceType) {
        conditions.push(eq(auditLog.resourceType, filters.resourceType));
      }
      if (filters?.userId) {
        conditions.push(eq(auditLog.userId, filters.userId));
      }
      if (filters?.status) {
        conditions.push(eq(auditLog.status, filters.status));
      }
      if (filters?.from) {
        conditions.push(gte(auditLog.createdAt, new Date(filters.from)));
      }
      if (filters?.to) {
        conditions.push(lte(auditLog.createdAt, new Date(filters.to)));
      }

      const result = await this.db
        .select()
        .from(auditLog)
        .where(and(...conditions));

      return result.length;
    } catch (err) {
      this.log?.error("Failed to count audit entries", {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return 0;
    }
  }
}
