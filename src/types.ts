// Cortex — Shared Types

// ---------------------------------------------------------------------------
// Cloudflare Worker Environment
// ---------------------------------------------------------------------------
export interface Env {
  // KV
  SESSION_CACHE: KVNamespace;
  WORKFLOW_STATE: KVNamespace;

  // Hyperdrive
  HYPERDRIVE: Hyperdrive;

  // R2
  R2_BUCKET: R2Bucket;

  // Workers AI
  AI: Ai;

  // Analytics Engine
  ANALYTICS?: AnalyticsEngineDataset;

  // Durable Objects
  WORKFLOW_DO: DurableObjectNamespace;

  // Workflows (CF Workflows binding)
  SKILL_WORKFLOW?: Workflow;

  // Service Bindings
  RUNICS_SERVICE?: Fetcher;

  // Vars
  ENVIRONMENT: string;
  CORS_ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins (production only)
  RUNICS_URL: string;
  DAYTONA_TARGET: string;
  DAYTONA_API_URL: string;
  LLM_MODEL: string;
  TOOL_CALL_MODEL?: string;
  DEFAULT_EXECUTION_MODE: ExecutionMode;
  DEFAULT_APPETITE: Appetite;
  WORKFLOW_TIMEOUT_MS: string;
  MAX_SKILL_CHAIN_DEPTH: string;

  // LLM Proxy
  LLMPROXY_URL: string;
  LLMPROXY_API_KEY: string;

  // Cloudflare API (for Analytics Engine queries)
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;

  // Secrets
  DAYTONA_API_KEY: string;
  DATABASE_URL: string;
  ADMIN_SECRET: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface ApiKeyData {
  tenantId: string;
  userId: string;
  product: Product;
  scopes: string[];
  source?: ApiKeySource;
  createdAt: string;
}

export type ApiKeySource = "chat" | "job" | "webhook" | "api";

export interface AppVariables {
  tenantId: string;
  userId: string;
  product: Product;
  scopes: string[];
  requestId: string;
  apiKeyPrefix: string; // First 12 chars of API key for rate limiting/tracking
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
export type ExecutionLayer = "mcp-remote" | "instructions" | "worker" | "container" | "composite";

export type ExecutionMode = "full_auto" | "review_before_run" | "step_by_step";

export interface ExecutionResult {
  success: boolean;
  output: unknown;
  durationMs: number;
  layer: ExecutionLayer;
  error?: string;
}

// ---------------------------------------------------------------------------
// Skills (mirrors Runics types for client use)
// ---------------------------------------------------------------------------
export type SkillStatus =
  | "draft"
  | "published"
  | "deprecated"
  | "vulnerable"
  | "revoked"
  | "degraded"
  | "contains-vulnerable";

export type SkillType = "atomic" | "auto-composite" | "human-composite" | "forked";

export type Appetite = "strict" | "cautious" | "balanced" | "adventurous";

export type VerificationTier = "unverified" | "scanned" | "verified" | "certified";

export type TrustBadge = "human-verified" | "auto-distilled" | "upstream" | null;

export interface SkillReference {
  id: string;
  slug: string;
  version: string;
  name: string;
  executionLayer: ExecutionLayer;
  trustScore: number;
  verificationTier: VerificationTier;
  trustBadge: TrustBadge;
  status: SkillStatus;
  skillType: SkillType;

  // Execution details
  mcpUrl?: string;
  skillMd?: string;
  r2BundleKey?: string;
  schemaJson?: Record<string, unknown>;
  capabilitiesRequired?: string[];

  // Status metadata
  revokedReason?: string;
  remediationMessage?: string;
  remediationUrl?: string;
  replacementSkillId?: string;

  // Usage signal
  runCount: number;
  lastRunAt?: string;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------
export interface WorkflowPlan {
  id: string;
  steps: WorkflowStep[];
  mode: ExecutionMode;
  createdAt: string;
}

export interface WorkflowStep {
  id: string;
  order: number;
  skill: SkillReference;
  inputMapping?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  onError: "fail" | "skip" | "retry";
  status: StepStatus;
  result?: ExecutionResult;
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "paused";

// ---------------------------------------------------------------------------
// DAG Workflow (spec v2.0)
// ---------------------------------------------------------------------------

/**
 * WorkflowDAG — DAG-based workflow definition per @runics/dag format.
 * Supports parallel execution, conditional branching, and dependency tracking.
 */
export interface WorkflowDAG {
  id: string;
  steps: DAGStep[];
  mode: ExecutionMode;
  createdAt: string;
  /** Optional metadata */
  name?: string;
  description?: string;
}

/**
 * DAGStep — A single step in a DAG workflow with dependency support.
 */
export interface DAGStep {
  id: string;
  /** Step IDs that must complete before this step runs */
  dependsOn?: string[];
  /** Skill binding mode */
  binding: "static" | "dynamic";
  /** Skill reference: slug@version for static, natural language query for dynamic */
  skillRef: string;
  /** Resolved skill (populated at execution time) */
  skill?: SkillReference;
  /** Input mapping with template expressions ($prev, $step.N, $context) */
  inputMapping?: Record<string, unknown>;
  /** Condition expression — step runs only if evaluated to true */
  condition?: DAGCondition;
  /** Error handling strategy */
  onError: "fail" | "skip" | "retry";
  /** Retry configuration (required if onError is 'retry') */
  retry?: RetryConfig;
  /** Whether this step requires human approval before execution */
  requiresApproval?: boolean;
  /** Step execution status */
  status: StepStatus;
  /** Execution result after completion */
  result?: ExecutionResult;
}

/**
 * DAGCondition — Condition expression for conditional step execution.
 * Supports simple expressions evaluated against workflow outputs.
 */
export interface DAGCondition {
  /** Expression type */
  type: "expression" | "jmespath";
  /** Expression string (e.g., "$step.0.result.success === true") */
  expr: string;
}

/**
 * RetryConfig — Per-step retry configuration.
 */
export interface RetryConfig {
  /** Maximum retry attempts */
  count: number;
  /** Delay between retries in milliseconds */
  delayMs: number;
  /** Backoff strategy */
  backoff?: "linear" | "exponential";
}

/**
 * DAGExecutionLayer — A group of DAG steps that can execute in parallel.
 * Steps in the same layer have no interdependencies.
 */
export interface DAGExecutionLayer {
  index: number;
  stepIds: string[];
}

export interface WorkflowState {
  workflowId: string;
  tenantId: string;
  userId: string;
  product: Product;
  mode: ExecutionMode;
  plan: WorkflowPlan;
  currentStepIndex: number;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  pausedAt?: string;
  timeoutAt?: string;
  resumeData?: unknown;
  error?: string;
  conversationId?: string;
}

export type WorkflowStatus = "planning" | "paused_for_review" | "running" | "paused_at_step" | "completed" | "failed" | "timed_out" | "terminated";

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export type Product = "bombastic" | "costaff" | "controlcenter";

export interface ProductConfig {
  product: Product;
  systemPrompt: string;
  defaultMode: ExecutionMode;
  defaultAppetite: Appetite;
  trustFloor: number;
  enablePolicyEngine: boolean;
  enableHumanReview: boolean;
}

// ---------------------------------------------------------------------------
// Multi-Tenancy
// ---------------------------------------------------------------------------
export type Visibility = "public" | "team" | "private";

export interface TenantContext {
  tenantId: string;
  userId: string;
  product: Product;
  appetite: Appetite;
  executionMode: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Runics Client Types (search request/response)
// ---------------------------------------------------------------------------
export interface FindSkillRequest {
  query: string;
  tenantId: string;
  userId?: string;
  appetite?: Appetite;
  tags?: string[];
  category?: string;
  limit?: number;
  version?: string;
}

export interface FindSkillResponse {
  results: SkillReference[];
  confidence: "high" | "medium" | "low_enriched" | "no_match";
  enriched: boolean;
  composition?: {
    detected: boolean;
    parts: string[];
  };
  meta: {
    latencyMs: number;
    tier: 1 | 2 | 3;
    cacheHit: boolean;
    llmInvoked: boolean;
  };
}

// ---------------------------------------------------------------------------
// Forge Client Types
// ---------------------------------------------------------------------------
export interface DistillRequest {
  traceId: string;
  workflowState: WorkflowState;
  mode: "auto" | "human";
  userId?: string;
  name?: string;
  description?: string;
  visibility?: Visibility;
}

export interface SaveAsSkillResponse {
  skillId: string;
  slug: string;
  name: string;
  version: string;
  trustScore: number;
  composedFrom: { skillId: string; slug: string; version: string; trustScore: number }[];
  visibility: Visibility;
  executionLayer: "composite";
  skillType: "human-composite";
  trustBadge: "human-verified";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Composite Skill Management Types
// ---------------------------------------------------------------------------
export interface ListCompositesResponse {
  skills: SkillReference[];
  total: number;
  limit: number;
  offset: number;
}

export interface CompositeSkillDetail extends SkillReference {
  description: string;
  tags: string[];
  category?: string;
  visibility: Visibility;
  tenantId?: string;
  createdAt: string;
  updatedAt?: string;
  compositionSteps: CompositionStep[];
  compositionSkillIds: string[];
  forkedFrom?: string;
  forkedBy?: string;
  forkChanges?: string[];
  deprecatedAt?: string;
  deprecatedReason?: string;
}

export interface CompositionStep {
  stepOrder: number;
  skillId: string;
  skillSlug: string;
  skillVersion: string;
  stepName: string;
  inputMapping?: Record<string, unknown>;
  onError: "fail" | "skip" | "retry";
}

export interface UpdateCompositeRequest {
  name?: string;
  description?: string;
  tags?: string[];
  category?: string;
  visibility?: Visibility;
}

export interface DeprecateCompositeRequest {
  reason?: string;
  replacementSkillSlug?: string;
}

export interface ForkCompositeRequest {
  changes: string[];
  modifications?: {
    removeSteps?: number[];
    reorderSteps?: number[];
    swapSteps?: Array<{
      stepOrder: number;
      newSkillSlug: string;
      newSkillVersion?: string;
    }>;
    addSteps?: Array<{
      afterStepOrder: number;
      skillSlug: string;
      skillVersion?: string;
      stepName: string;
      inputMapping?: Record<string, unknown>;
      onError?: "fail" | "skip" | "retry";
    }>;
  };
}

export interface ForkCompositeResponse {
  id: string;
  slug: string;
  version: string;
  forkedFrom: string;
  trustScore: number;
  status: "draft";
  skillType: "forked";
}

// ---------------------------------------------------------------------------
// Cognium Client Types
// ---------------------------------------------------------------------------
export type CogniumSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface TrustCheckResult {
  skillId: string;
  trustScore: number;
  verificationTier: VerificationTier;
  severity?: CogniumSeverity;
  findings: CogniumFinding[];
  blocked: boolean;
  warning?: string;
}

export interface CogniumFinding {
  severity: CogniumSeverity;
  cweId?: string;
  tool: string;
  title: string;
  description: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Daytona Client Types
// ---------------------------------------------------------------------------
export interface SandboxRequest {
  skillId: string;
  command: string;
  bundleKey?: string;
  language?: string;
  snapshot?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSecs?: number;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// API Request/Response
// ---------------------------------------------------------------------------
export interface RunRequest {
  prompt: string;
  tenantId: string;
  userId: string;
  product: Product;
  mode?: ExecutionMode;
  appetite?: Appetite;
  context?: Record<string, unknown>;
  conversationId?: string;
  model?: string;
  systemInstructions?: string;
}

export interface RunResponse {
  workflowId: string;
  status: WorkflowStatus;
  plan?: WorkflowPlan;
  result?: unknown;
  summary?: string;
  conversationId?: string;
  usage?: { totalTokens: number; totalCost: number };
}

export interface ResumeRequest {
  workflowId: string;
  approved: boolean;
  modifiedPlan?: WorkflowPlan;
}

// ---------------------------------------------------------------------------
// Audit Log (Mandate v0.5)
// ---------------------------------------------------------------------------
export type AuditAction =
  | "api_key.create"
  | "api_key.revoke"
  | "policy.create"
  | "policy.update"
  | "workflow.run"
  | "workflow.resume"
  | "workflow.terminate"
  | "session.delete"
  | "conversation.delete"
  | "composite.update"
  | "composite.deprecate"
  | "composite.fork";

export type AuditResourceType =
  | "api_key"
  | "policy"
  | "workflow"
  | "session"
  | "conversation"
  | "composite";

export type AuditStatus = "success" | "failure" | "denied";

export interface AuditEntry {
  id?: string;
  tenantId: string;
  userId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  status: AuditStatus;
  errorMessage?: string;
  createdAt?: string;
}

export interface AuditQueryFilters {
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  userId?: string;
  status?: AuditStatus;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Streaming — AI SDK UI Message Stream v1
// https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
// ---------------------------------------------------------------------------
export type StreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; result: unknown }
  | { type: "step-start"; messageId: string; [key: string]: unknown }
  | { type: "step-finish"; finishReason: string; usage?: { promptTokens?: number; completionTokens?: number }; [key: string]: unknown }
  | { type: "data"; data: unknown[] }
  | { type: "error"; errorText: string }
  | { type: "finish"; finishReason: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } };

export type OnStreamEvent = (part: StreamPart) => void | Promise<void>;
