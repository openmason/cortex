import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  smallint,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Workflow Sessions
// ---------------------------------------------------------------------------
export const workflowSessions = pgTable(
  "workflow_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    product: text("product").notNull(),
    mode: text("mode").notNull().default("review_before_run"),
    status: text("status").notNull().default("planning"),
    prompt: text("prompt").notNull(),
    conversationId: text("conversation_id"),
    planJson: jsonb("plan_json"),
    resumeData: jsonb("resume_data"),
    currentStepIndex: smallint("current_step_index").default(0),
    result: jsonb("result"),
    summary: text("summary"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_workflow_sessions_tenant").on(table.tenantId, table.createdAt),
    index("idx_workflow_sessions_user").on(table.userId, table.createdAt),
    index("idx_workflow_sessions_status").on(table.status),
    index("idx_workflow_sessions_conversation").on(table.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// Workflow Step Executions
// ---------------------------------------------------------------------------
export const workflowStepExecutions = pgTable(
  "workflow_step_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => workflowSessions.id, { onDelete: "cascade" }),
    stepOrder: smallint("step_order").notNull(),
    skillId: text("skill_id").notNull(),
    skillSlug: text("skill_slug").notNull(),
    skillVersion: text("skill_version").notNull(),
    executionLayer: text("execution_layer").notNull(),
    status: text("status").notNull().default("pending"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_step_executions_session").on(table.sessionId, table.stepOrder),
    index("idx_step_executions_skill").on(table.skillId),
  ],
);

// ---------------------------------------------------------------------------
// Execution Logs (for Forge distillation)
// ---------------------------------------------------------------------------
export const executionTraces = pgTable(
  "execution_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => workflowSessions.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    product: text("product").notNull(),
    prompt: text("prompt").notNull(),
    planJson: jsonb("plan_json").notNull(),
    stepsExecuted: jsonb("steps_executed").notNull(),
    totalDurationMs: integer("total_duration_ms"),
    success: boolean("success").notNull(),
    userModifiedPlan: boolean("user_modified_plan").default(false),
    savedAsSkill: boolean("saved_as_skill").default(false),
    savedSkillId: text("saved_skill_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_traces_tenant").on(table.tenantId, table.createdAt),
    index("idx_traces_saved").on(table.savedAsSkill),
  ],
);

// ---------------------------------------------------------------------------
// Tenant Policies
// ---------------------------------------------------------------------------
export const tenantPolicies = pgTable(
  "tenant_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    product: text("product").notNull(),
    defaultMode: text("default_mode").notNull().default("review_before_run"),
    defaultAppetite: text("default_appetite").notNull().default("balanced"),
    trustFloor: real("trust_floor").notNull().default(0.5),
    enableHumanReview: boolean("enable_human_review").default(true),
    sensitiveCategories: jsonb("sensitive_categories").default([]),
    blockedSkillSlugs: jsonb("blocked_skill_slugs").default([]),
    maxConcurrentWorkflows: integer("max_concurrent_workflows").default(10),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_tenant_policies_tenant").on(table.tenantId, table.product),
  ],
);

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    product: text("product").notNull(),
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_api_keys_key").on(table.key),
    index("idx_api_keys_tenant").on(table.tenantId),
  ],
);
