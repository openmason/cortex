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

  // Queues
  FORGE_QUEUE: Queue;
  COGNIUM_QUEUE: Queue;

  // Workers AI
  AI: Ai;

  // Durable Objects
  WORKFLOW_DO: DurableObjectNamespace;

  // Service Bindings
  RUNICS_SERVICE?: Fetcher;

  // Vars
  ENVIRONMENT: string;
  RUNICS_URL: string;
  COGNIUM_URL: string;
  DAYTONA_URL: string;
  LLM_MODEL: string;
  DEFAULT_EXECUTION_MODE: ExecutionMode;
  DEFAULT_APPETITE: Appetite;
  WORKFLOW_TIMEOUT_MS: string;
  MAX_SKILL_CHAIN_DEPTH: string;

  // LLM Proxy
  LLMPROXY_URL: string;
  LLMPROXY_API_KEY: string;

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
  createdAt: string;
}

export interface AppVariables {
  tenantId: string;
  userId: string;
  product: Product;
  scopes: string[];
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
}

export type WorkflowStatus = "planning" | "paused_for_review" | "running" | "paused_at_step" | "completed" | "failed" | "timed_out";

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
  bundleKey: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
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
}

export interface RunResponse {
  workflowId: string;
  status: WorkflowStatus;
  plan?: WorkflowPlan;
  result?: unknown;
  summary?: string;
  conversationId?: string;
}

export interface ResumeRequest {
  workflowId: string;
  approved: boolean;
  modifiedPlan?: WorkflowPlan;
}

// ---------------------------------------------------------------------------
// Streaming (SSE)
// ---------------------------------------------------------------------------
export type SSEEventType =
  | "conversation"
  | "planning"
  | "tool_call"
  | "tool_result"
  | "step_start"
  | "step_complete"
  | "workflow_complete"
  | "error"
  | "done";

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
}
