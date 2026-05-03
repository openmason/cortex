# Cortex Specification — v2.1

> **Applies to:** `cortex-specification.md` — updated to reflect implemented architecture
> **Version:** 2.1 · May 2026
> **Status:** Implemented. 558 tests passing. Live at staging.
> **Company:** Cognium Labs
> **Stack:** TypeScript · Cloudflare Workers · Cloudflare Workflows · Daytona SDK · Hono · Drizzle ORM · KV · R2 · Analytics Engine
> **Companion docs:** `cognium-architecture-overview.md` · `runics-dag-specification.md` · `runics-unified-architecture.md` · `api-key-middleware-specification.md` · `bombastic-specification.md`
>
> **v2.1 changes:** Full implementation complete. Custom SupervisorAgent replaces Mastra wrapper (inline, not separate Worker). Daytona SDK for sandbox execution (not CF Sandbox SDK). Forge fully decoupled (no queues — subscribes to events independently). Five execution layers: mcp-remote, instructions, worker, container, composite + codegen fallback. CF Workflows POC (SkillWorkflow) added alongside existing WorkflowEngine. AI SDK Data Stream Protocol for all streaming endpoints.

---

## 1. What Cortex Is

Cortex is the execution spine of Cognium Labs. It is a durable workflow engine that executes DAGs of skills, coordinating between skill discovery (Runics), trust verification (cached scores from Runics), LLM reasoning (inline SupervisorAgent), and sandbox execution (Daytona).

Every product (Clove, CoStaff, ControlDeck, Akrobatos, Bombastic) calls Cortex to execute work. Cortex owns the lifecycle of every workflow: instantiation, step execution, approval pausing, error handling, and completion notification.

**What Cortex is NOT:**
- Not a skill registry (that's Runics)
- Not a trust scanner (that's Cognium, called by Runics at ingestion)
- Not a skill generator (that's Forge, subscribes to workflow events independently)
- Not a product state manager (products own their own state)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CORTEX (CF Worker)                             │
├─────────────────────────────────────────────────────────────────────────┤
│  Hono Router → Auth Middleware → Rate Limiter → Route Handlers          │
│       │                                                                  │
│       ├── /v1/run ───────────▶ SupervisorAgent (LLM agentic loop)       │
│       │                              │                                   │
│       │                              ├── findSkill (→ Runics)            │
│       │                              ├── checkPolicy                     │
│       │                              ├── buildPlan                       │
│       │                              └── invokeSkill                     │
│       │                                     │                            │
│       │                              ExecutionRouter                     │
│       │                              ├── L0: mcp-remote (HTTP)           │
│       │                              ├── L1: instructions (LLM)          │
│       │                              ├── L2: worker (fetch)              │
│       │                              ├── L3: container (Daytona)         │
│       │                              └── L4: composite (recursion)       │
│       │                                     │                            │
│       │                              Codegen Fallback (LLM → Daytona)    │
│       │                                                                  │
│       ├── /v1/chat ──────────▶ ConversationManager + SupervisorAgent    │
│       │                                                                  │
│       └── /v1/sessions ──────▶ DB Repository (Neon via Hyperdrive)      │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  WorkflowEngine (KV state) ◀──▶ WorkflowDurableObject (hibernation)     │
│                                                                          │
│  SkillWorkflow (CF Workflows POC) — durable step execution              │
└─────────────────────────────────────────────────────────────────────────┘
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────────┐
    │  Runics  │   │  Daytona │   │  LLM Proxy   │
    │  (HTTP)  │   │  (SDK)   │   │ (xus.one)    │
    └──────────┘   └──────────┘   └──────────────┘
```

### Internal Components

| Component | Location | Purpose |
|---|---|---|
| SupervisorAgent | `src/agents/supervisor.ts` | LLM agentic loop with tool calling |
| ExecutionRouter | `src/execution/router.ts` | Dispatches to 5 execution layers + codegen |
| WorkflowEngine | `src/workflow/engine.ts` | Multi-step orchestration with pause/resume |
| DAGWorkflowEngine | `src/workflow/dag-engine.ts` | DAG-based parallel execution |
| SkillWorkflow | `src/workflow/cf-workflow.ts` | CF Workflows POC (durable steps) |
| ConversationManager | `src/conversation/manager.ts` | Multi-turn state in KV |
| DaytonaClient | `src/clients/daytona.ts` | Sandbox execution via @daytonaio/sdk |
| RunicsClient | `src/clients/runics.ts` | Skill discovery with KV caching |
| LLMClient | `src/clients/llm.ts` | LLM proxy with model routing |

### External Dependencies

| Service | Connection | Purpose |
|---|---|---|
| Runics | Service binding / HTTP | Skill registry and discovery |
| Daytona | SDK (@daytonaio/sdk) | Container sandbox execution |
| LLM Proxy | HTTP (llmproxy.xus.one) | Model routing via LiteLLM → OpenRouter |
| Neon | Hyperdrive (postgres.js) | Durable workflow records, API keys |
| Forge | Decoupled (subscribes to events) | Trace capture → skill distillation |

---

## 3. Dual Execution Mode

### 3.1 Conversational Mode

For real-time chat with multi-turn memory. State persisted in KV via ConversationManager.

**When:** product sends `POST /v1/chat` — user is in a chat session expecting streaming response.

**Flow:**
1. ConversationManager loads/creates conversation state from KV
2. SupervisorAgent runs LLM agentic loop with tool calling
3. Tools: findSkill, checkPolicy, buildPlan, invokeSkill
4. Response streams via AI SDK Data Stream Protocol
5. Conversation state saved back to KV with turn metrics

**Streaming format:** AI SDK UI Message Stream v1 (`x-vercel-ai-ui-message-stream: v1`)
- Types: `text-start`, `text-delta`, `text-end`, `tool-call`, `tool-result`, `step-start`, `step-finish`, `data`, `error`, `finish`
- Custom data parts for: `conversation`, `workflow-complete`, `approval-required`

### 3.2 Workflow Mode

For single-shot or multi-step execution with durable state.

**When:** product sends `POST /v1/run` with prompt + appetite + mode.

**Flow:**
1. SupervisorAgent orchestrates skill discovery and execution
2. WorkflowEngine manages multi-step plans with pause/resume
3. State persisted to KV (WORKFLOW_STATE) and DB (workflow_sessions)
4. DAGWorkflowEngine for parallel step execution (Kahn's algorithm)
5. SkillWorkflow (CF Workflows POC) for durable step execution

**Execution modes:**
- `full_auto` — execute all steps without approval
- `step_by_step` — pause after each step for review
- `review_only` — pause only for steps with side effects

---

## 4. API Surface

### 4.1 Endpoints

| Method | Path | Purpose | Auth | Scope |
|---|---|---|---|---|
| `POST` | `/v1/run` | Start workflow (JSON or SSE with `stream:true`) | API key | `run` |
| `POST` | `/v1/run/stream` | Start workflow (SSE streaming) | API key | `run` |
| `GET` | `/v1/run/:id` | Query workflow state | API key | `run` |
| `POST` | `/v1/run/:id/resume` | Resume paused workflow | API key | `run` |
| `POST` | `/v1/run/:id/save` | Save workflow as composite skill | API key | `run` |
| `POST` | `/v1/chat` | Conversational mode (AI SDK streaming) | API key | `run` |
| `POST` | `/v1/approvals/:id/approve` | Approve paused workflow | API key | `run` |
| `POST` | `/v1/approvals/:id/reject` | Reject paused workflow | API key | `run` |
| `GET` | `/v1/sessions` | List workflow sessions (paginated) | API key | `sessions` |
| `GET` | `/v1/sessions/:id` | Session detail with step executions | API key | `sessions` |
| `GET` | `/v1/sessions/:id/trace` | Execution trace (for Forge) | API key | `sessions` |
| `GET` | `/v1/sessions/conversations` | List conversations | API key | `sessions` |
| `GET` | `/v1/sessions/conversations/:id` | Get conversation with messages | API key | `sessions` |
| `DELETE` | `/v1/sessions/conversations/:id` | Delete conversation | API key | `sessions` |
| `GET` | `/v1/skills/composites` | List composite skills | API key | `skills` |
| `GET` | `/v1/skills/composites/:slug` | Composite detail | API key | `skills` |
| `PATCH` | `/v1/skills/composites/:slug` | Update composite | API key | `skills` |
| `POST` | `/v1/skills/composites/:slug/deprecate` | Deprecate composite | API key | `skills` |
| `POST` | `/v1/skills/composites/:slug/fork` | Fork composite | API key | `skills` |
| `GET` | `/v1/models` | List available LLM models | API key | — |
| `GET` | `/health` | Service health (KV + DB + Runics) | Public | — |
| `POST` | `/admin/api-keys` | Create API key | Admin secret | — |
| `DELETE` | `/admin/api-keys/:key` | Revoke API key | Admin secret | — |
| `PUT` | `/admin/policies` | Upsert tenant policy | Admin secret | — |
| `GET` | `/admin/policies/:tenantId/:product` | Get tenant policy | Admin secret | — |
| `POST` | `/admin/workflows/skill` | Trigger CF Workflow (POC) | Admin secret | — |
| `GET` | `/admin/workflows/skill/:instanceId` | Query CF Workflow status | Admin secret | — |

### 4.2 POST /v1/chat

Clove-compatible conversational endpoint. Always streams AI SDK Data Stream Protocol.

```typescript
interface ChatRequest {
  productId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    parts?: MessagePart[];  // optional structured content
  }>;
  conversationId?: string;  // auto-generated if not provided
  systemInstructions?: string;  // product-specific system prompt
}
```

Returns: AI SDK UI Message Stream v1 (header: `x-vercel-ai-ui-message-stream: v1`)
- Stream ends with `: [DONE]`
- Custom data parts carry `conversation`, `workflow-complete`, `approval-required`

### 4.3 POST /v1/run

Start a workflow execution.

```typescript
interface RunRequest {
  product: string;         // product ID
  prompt: string;          // natural language task
  appetite?: 'strict' | 'cautious' | 'balanced' | 'adventurous';
  mode?: 'full_auto' | 'step_by_step' | 'review_only';
  stream?: boolean;        // true for SSE (or use Accept: text/event-stream)
  context?: Record<string, unknown>;  // additional context
}

interface RunResponse {
  id: string;              // workflow ID
  status: 'pending' | 'running' | 'paused_for_review' | 'completed' | 'failed' | 'timed_out';
  message?: string;
  plan?: WorkflowPlan;
  outputs?: Record<string, unknown>;
  usage?: { totalTokens: number; totalCost: number };
}
```

### 4.4 GET /v1/run/:id

Query workflow state.

```typescript
interface WorkflowState {
  id: string;
  status: 'pending' | 'running' | 'paused_for_review' | 'paused_at_step' | 'completed' | 'failed' | 'timed_out';
  plan?: WorkflowPlan;
  currentStepIndex: number;
  outputs: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  timeoutAt?: string;      // for paused workflows
}
```

### 4.5 POST /v1/run/:id/resume

Resume a paused workflow.

```typescript
interface ResumeRequest {
  approved?: boolean;      // false to reject and cancel
  input?: unknown;         // optional input override for current step
}
```

---

## 5. Workflow Execution

Cortex has multiple workflow engines for different use cases:

### 5.1 WorkflowEngine (Primary)

The main orchestration engine for multi-step execution with pause/resume.

```typescript
// src/workflow/engine.ts
class WorkflowEngine {
  constructor(env: Env, durableObject?: DurableObjectStub, log?: Logger, metrics?: Metrics);

  async start(plan: WorkflowPlan, context: ExecutionContext): Promise<WorkflowState>;
  async resume(workflowId: string, approved: boolean, input?: unknown): Promise<WorkflowState>;
  async loadState(workflowId: string): Promise<WorkflowState | null>;
  async checkAndApplyTimeout(state: WorkflowState): Promise<void>;
}
```

State stored in KV (WORKFLOW_STATE) with DB fallback (workflow_sessions table).

### 5.2 DAGWorkflowEngine

For parallel step execution using Kahn's algorithm.

```typescript
// src/workflow/dag-engine.ts
class DAGWorkflowEngine {
  constructor(env: Env, runics: RunicsClient, router: ExecutionRouter);

  async execute(dag: WorkflowDAG, context: ExecutionContext): Promise<Record<string, unknown>>;
}
```

Uses `toDAGExecutionLayers()` to compute parallel execution layers, then executes each layer with `Promise.all()`.

### 5.3 SkillWorkflow (CF Workflows POC)

Durable workflow execution using Cloudflare Workflows API.

```typescript
// src/workflow/cf-workflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface SkillWorkflowParams {
  skillSlug: string;
  skillVersion?: string;
  input: Record<string, unknown>;
  tenantId: string;
  requestId?: string;
}

export class SkillWorkflow extends WorkflowEntrypoint<Env, SkillWorkflowParams> {
  async run(event: WorkflowEvent<SkillWorkflowParams>, step: WorkflowStep) {
    // Step 1: Resolve skill with retry
    const skill = await step.do<SerializedSkill>('resolve-skill', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      timeout: '30 seconds',
    }, async () => {
      // Lookup skill from Runics
    });

    // Step 2: Execute skill with retry
    const result = await step.do<SerializedResult>('execute-skill', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '5 minutes',
    }, async () => {
      // Execute via ExecutionRouter
    });

    return { success: true, skillSlug, output: result };
  }
}
```

**CF Workflows key considerations:**
1. Step return values are persisted — in-memory state lost on hibernation
2. Step names must be deterministic (no timestamps/random values)
3. Step outputs capped at 1 MiB — use R2 for large results
4. Each `step.do()` can have independent retry/timeout config

---

## 6. Skill Resolution

### 6.1 Static Binding

```typescript
async resolveSkill(dagStep: WorkflowStep, config: CortexSessionConfig) {
  if (dagStep.binding === 'static') {
    // skillRef is "slug@version" — direct lookup
    const [slug, version] = dagStep.skillRef.split('@');
    return await this.env.RUNICS_CLIENT.getSkill(slug, version);
  }
  // ... dynamic binding below
}
```

### 6.2 Dynamic Binding

```typescript
if (dagStep.binding === 'dynamic') {
  // skillRef is a natural language query — search Runics
  const results = await this.env.RUNICS_CLIENT.search({
    query: dagStep.skillRef,
    appetite: config.appetite,
    minTrust: config.minTrust,
    allowVulnerable: config.allowVulnerable,
    limit: 1,
  });
  return results[0] ?? null;
}
```

---

## 7. Execution Layers

The ExecutionRouter dispatches to 5 execution layers based on skill metadata:

```typescript
// src/execution/router.ts
class ExecutionRouter {
  constructor(env: Env, llm?: LLMClient, log?: Logger, metrics?: Metrics);

  async execute(skill: SkillReference, input: Record<string, unknown>): Promise<ExecutionResult>;
}
```

### 7.1 Layer 0: MCP Remote

HTTP call to MCP server endpoint.

```typescript
// When: skill.executionLayer === 'mcp-remote' && skill.mcpUrl exists
const response = await fetch(skill.mcpUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: 'tools/call', params: { name: skill.slug, arguments: input } }),
});
```

### 7.2 Layer 1: Instructions

Inject skill_md into LLM context for reasoning-based execution.

```typescript
// When: skill.executionLayer === 'instructions' && skill.skillMd exists
const response = await this.llm.chat([
  { role: 'system', content: skill.skillMd },
  { role: 'user', content: JSON.stringify(input) },
]);
```

### 7.3 Layer 2: Worker

Fetch-based execution for simple HTTP skills.

```typescript
// When: skill.executionLayer === 'worker' && skill.workerUrl exists
const response = await fetch(skill.workerUrl, {
  method: 'POST',
  body: JSON.stringify(input),
});
```

### 7.4 Layer 3: Container (Daytona)

Full sandbox execution via Daytona SDK.

```typescript
// When: skill.executionLayer === 'container' && skill.r2BundleKey exists
const daytona = new DaytonaClient(this.env, this.log, this.metrics);
const result = await daytona.runCode(code, 'typescript', input);
// OR for shell commands:
const result = await daytona.execute(command, cwd);
```

### 7.5 Layer 4: Composite

Recursive execution of sub-skills.

```typescript
// When: skill.skillType === 'composite'
const subResults = [];
for (const step of skill.composition) {
  const subSkill = await this.runics.getSkill(step.skillSlug, step.skillVersion);
  const subInput = resolveInputMapping(step.inputMapping, input, subResults);
  subResults.push(await this.execute(subSkill, subInput));
}
```

### 7.6 Codegen Fallback

When no executable layer matches, generate and execute code via LLM + Daytona:

```typescript
// When: no mcpUrl, no skillMd, no r2BundleKey
const code = await this.llm.chat([
  { role: 'system', content: CODEGEN_SYSTEM_PROMPT },
  { role: 'user', content: `Generate Node.js code for: ${skill.description}\nInput: ${JSON.stringify(input)}` },
]);
const cleanCode = stripFences(code);  // Remove markdown fences

const daytona = new DaytonaClient(this.env);
const result = await daytona.runCode(cleanCode, 'typescript', input);

// On failure, retry once with error feedback
if (!result.success) {
  const retryCode = await this.llm.chat([...messages, { role: 'user', content: `Error: ${result.error}. Fix the code.` }]);
  result = await daytona.runCode(stripFences(retryCode), 'typescript', input);
}
```

---

## 8. Product Session Config

Each product has default configuration, resolved server-side.

```typescript
interface CortexSessionConfig {
  productId: string;
  tenantId: string | null;
  userId: string;
  systemPrompt: string;
  appetite: 'strict' | 'cautious' | 'balanced' | 'adventurous';
  minTrust: number;
  allowVulnerable: boolean;
  approvalMode: 'never' | 'side-effects-only' | 'policy-defined' | 'always';
  modelMap?: Record<string, string>;
  defaultModel?: string;
}
```

| Product | Appetite | Min Trust | Approval Mode |
|---|---|---|---|
| Bombastic | `balanced` | 0.50 | `side-effects-only` |
| CoStaff | `cautious` | 0.70 | `policy-defined` |
| ControlDeck | `cautious` | 0.70 | `side-effects-only` |
| Akrobatos | `strict` | 0.85 | `always` |

---

## 9. Approval Engine

### 9.1 Approval Flow

When a DAG step has `requiresApproval: true`:

1. Executor calls `step.waitForEvent('approval-{stepId}', { timeout: '30 minutes' })`
2. Cortex pushes an approval request to the product DO via WebSocket
3. Product surfaces the approval on its board (product-specific UX)
4. User approves/rejects in the product
5. Product calls `POST /v1/approvals/:id/approve` or `reject`
6. API Worker calls `instance.sendEvent({ type: 'approval-{stepId}', payload: { decision } })`
7. Workflow resumes or skips the step

### 9.2 Timeout

Default: 30 minutes. Configurable per step via DAG definition (future schema extension). On timeout, the step is skipped and the workflow continues (or fails, depending on `onError`).

### 9.3 Routing

Cortex emits approval events. Products own routing (which user sees the approval, escalation policies, batching). This is product-specific RBAC, not Cortex's concern.

---

## 10. Forge Integration (Decoupled)

### 10.1 Architecture

Forge is a **separate service** that subscribes to workflow events independently. Cortex does NOT embed Forge — no internal queues.

```
Cortex ──emits──▶ Workflow Events ──▶ Forge (subscriber)
                                           │
                                           ▼
                                     Runics (skill publish)
```

### 10.2 What Forge Does

1. Subscribes to workflow completion events (webhook or queue consumer)
2. Evaluates trace quality (reusability judge)
3. Distills traces into reusable skills
4. Publishes skills to Runics as `source: 'forge'`

### 10.3 Cortex's Role

Cortex provides:
- `GET /v1/sessions/:id/trace` — returns execution trace for completed workflows
- `humanDistill()` via ForgeClient — user-initiated save-as-skill (POST /v1/run/:id/save)

### 10.4 Trace Schema

```typescript
interface ExecutionTrace {
  workflowId: string;
  tenantId: string;
  product: string;
  prompt: string;
  plan: WorkflowPlan;
  steps: StepExecution[];
  completedAt: string;
  totalDurationMs: number;
}

interface StepExecution {
  id: string;
  skillSlug: string;
  skillVersion: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
}
```

---

## 11. SupervisorAgent (LLM Orchestration)

### 11.1 What It Is

A custom LLM agentic loop built inline in Cortex. **Not using Mastra** — Mastra dependencies exist in package.json but are unused.

### 11.2 What It Does

```typescript
// src/agents/supervisor.ts
class SupervisorAgent {
  constructor(llm: LLMClient, tools: ToolExecutor, config: AgentConfig);

  async handleRequest(request: RunRequest): Promise<RunResponse>;
  async handleRequestStreaming(request: RunRequest): AsyncIterable<SSEEvent>;
}
```

**Agentic loop:**
1. Send messages to LLM with tool definitions
2. LLM returns tool calls (findSkill, checkPolicy, buildPlan, invokeSkill)
3. Execute tools via ToolExecutor
4. Feed results back to LLM
5. Repeat until LLM returns final response (no more tool calls)

### 11.3 Available Tools

| Tool | Purpose |
|---|---|
| `findSkill` | Search Runics for matching skills |
| `checkPolicy` | Verify tenant policy allows execution |
| `buildPlan` | Create multi-step workflow plan |
| `invokeSkill` | Execute a skill via ExecutionRouter |
| `extractMemory` | Extract key information from conversation (Bombastic) |

### 11.4 Multi-Turn Tool Calling

```typescript
// LLMClient.agentLoop() handles multi-turn automatically
const result = await this.llm.agentLoop(messages, tools, {
  maxTurns: 10,
  onToolCall: (call) => this.tools.execute(call),
});
```

Handles OpenRouter/proxy quirks:
- `finish_reason` variants (`tool_calls`, `tool_call`, `function_call`)
- Arguments normalization (object → string)
- `content:null` → `""` conversion
- Model fallback chains (proxy-side)

### 11.5 Why Not Mastra

Mastra's Cloudflare support was too immature at build time (v0.1.0). The custom implementation provides:
- Full control over tool calling semantics
- Direct integration with Cortex's execution pipeline
- No separate Worker overhead (inline in same process)
- Simpler debugging and observability

---

## 12. Credential Vault

Forked MCP skills may point to a user's own service instances. Credentials stored per-tenant in KV, encrypted at rest.

```typescript
// KV key: credentials:{tenantId}:{skillId}
interface SkillCredentials {
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string }>;
  envVars?: Record<string, string>;
  oauthToken?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}
```

Credentials never stored in skill records. Cognium Config Analyzer flags hardcoded secrets. Credential injection happens in the executor, per step, scoped to tenant.

---

## 13. Skill Revocation Handling

When Runics emits a skill revocation event:

1. Cortex receives the event (via webhook or queue)
2. Cortex identifies affected running workflow instances (by scanning active instances for the revoked skill ID)
3. Cortex pushes notification to product DOs via WebSocket
4. Each product handles per its own logic (pause, notify, auto-substitute)

For static-binding workflows referencing the revoked skill: the next execution of that step will fail with a trust check error. The product can update the DAG to reference a patched version.

---

## 14. Deployment

### Environments

| Environment | URL | CF Account | Config File |
|-------------|-----|------------|-------------|
| **Production** | `https://cortex.cognium.net` | cognium (`bb8e02ea0ca7c225d2fb62d24a9940be`) | `wrangler.production.toml` |
| **Staging** | `https://cortex.phantoms.workers.dev` | phantoms (`1f59f4dcd0ebb559e3c392566978d446`) | `wrangler.toml` |

### Deploy Commands

```bash
# Staging
npx wrangler deploy

# Production
npx wrangler deploy -c wrangler.production.toml
```

### Production Resources

| Resource | ID/Name |
|----------|---------|
| Neon DB | `ep-lucky-sound-akb7l8dj` (us-west-2) |
| Hyperdrive | `c9aee067341446239e483dbf6df25f96` |
| KV SESSION_CACHE | `d827ec6be74641ee8fa53a0af4cd7e1b` |
| KV WORKFLOW_STATE | `d4180b7f747f47baa0c36f24b75dd0ef` |
| R2 | `cortex-artifacts` |
| Runics Service | `runics` (service binding) |

### Secrets

```bash
npx wrangler secret put LLMPROXY_API_KEY -c wrangler.production.toml
npx wrangler secret put DATABASE_URL -c wrangler.production.toml
npx wrangler secret put ADMIN_SECRET -c wrangler.production.toml
```

### Wrangler Configuration

See `wrangler.toml` (staging) and `wrangler.production.toml` (production) for full config.

Key bindings:
- `WORKFLOW_DO` — Durable Object for workflow state
- `SESSION_CACHE` / `WORKFLOW_STATE` — KV namespaces
- `HYPERDRIVE` — Neon Postgres connection pool
- `R2_BUCKET` — Artifact storage
- `RUNICS_SERVICE` — Service binding to Runics worker
- `ANALYTICS` — Analytics Engine dataset
- `AI` — Workers AI

---

## 15. MVP Native Connectors

Activepieces connectors are imported as code (npm packages). For MVP, build critical connectors natively using `ofetch` inside Workers. Full Activepieces catalog integration is deferred until 200+ connectors are needed.

### MVP Connector List

| Connector | Use case | Priority |
|---|---|---|
| Web fetch / HTTP | Generic API calls, web scraping | P0 |
| Email (send) | Compose and send emails | P0 |
| Email (read) | Parse incoming email content | P1 |
| Google Calendar | Create/read/update events | P0 |
| Slack | Send messages, read channels | P0 |
| GitHub | Issues, PRs, repos, webhooks | P0 |
| Google Docs/Sheets | Read/write documents | P1 |
| Stripe | Payment processing, invoices | P1 |
| Jira | Issue tracking, project management | P1 |
| PagerDuty | Incident management (Akrobatos) | P1 |
| Datadog | Monitoring/metrics (Akrobatos) | P1 |
| Twilio / WhatsApp | SMS and messaging | P2 |
| Notion | Knowledge base, docs | P2 |
| Linear | Issue tracking (dev teams) | P2 |
| Salesforce | CRM (CoStaff) | P2 |

Each connector is a Workers-compatible module: `ofetch` for HTTP, Zod for response validation, typed input/output schemas matching Runics skill conventions.

---

## 16. Project Structure

```
cortex/
├── wrangler.toml                   # CF Workers config (staging)
├── wrangler.production.toml        # CF Workers config (production)
├── package.json
├── CLAUDE.md                       # Development context
├── cortex-specification.md         # This file
├── src/
│   ├── index.ts                    # Hono app, cron handler, exports
│   ├── types.ts                    # Shared types, Env, AppVariables
│   ├── agents/
│   │   ├── supervisor.ts           # SupervisorAgent (LLM agentic loop)
│   │   └── tools.ts                # Tool definitions, ToolExecutor
│   ├── clients/
│   │   ├── llm.ts                  # LLMClient (proxy, agentLoop, models)
│   │   ├── runics.ts               # RunicsClient (skill discovery, KV cache)
│   │   ├── daytona.ts              # DaytonaClient (sandbox execution)
│   │   ├── forge.ts                # ForgeClient (humanDistill only)
│   │   └── cognium.ts              # CogniumClient (trust checks, stateless)
│   ├── execution/
│   │   └── router.ts               # ExecutionRouter (5 layers + codegen)
│   ├── workflow/
│   │   ├── engine.ts               # WorkflowEngine (pause/resume)
│   │   ├── dag.ts                  # DAG utilities (layers, conditions)
│   │   ├── dag-engine.ts           # DAGWorkflowEngine (parallel exec)
│   │   ├── cf-workflow.ts          # SkillWorkflow (CF Workflows POC)
│   │   ├── durable-object.ts       # WorkflowDurableObject
│   │   └── input-mapping.ts        # $prev/$step.N resolver
│   ├── conversation/
│   │   └── manager.ts              # ConversationManager (KV state)
│   ├── routes/
│   │   ├── run.ts                  # /v1/run endpoints
│   │   ├── chat.ts                 # /v1/chat (AI SDK streaming)
│   │   ├── sessions.ts             # /v1/sessions, conversations CRUD
│   │   ├── skills.ts               # /v1/skills/composites CRUD
│   │   ├── approvals.ts            # /v1/approvals/:id/approve|reject
│   │   ├── analytics.ts            # /admin/analytics/usage
│   │   ├── admin.ts                # /admin/api-keys, policies, workflows
│   │   ├── health.ts               # /health
│   │   └── demo.ts                 # /demo
│   ├── middleware/
│   │   └── auth.ts                 # API key auth, rate limiting, usage tracking
│   ├── policy/
│   │   └── engine.ts               # PolicyEngine (tenant trust checks)
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema (5 tables)
│   │   └── repository.ts           # DB operations
│   └── observability/
│       ├── logger.ts               # Structured JSON logging
│       └── metrics.ts              # Analytics Engine metrics
├── tests/
│   ├── __mocks__/
│   │   └── cloudflare-workers.ts   # Mock DurableObject, WorkflowEntrypoint
│   ├── agents/
│   ├── clients/
│   ├── execution/
│   ├── workflow/
│   │   ├── engine.test.ts
│   │   ├── dag.test.ts
│   │   ├── dag-engine.test.ts
│   │   └── cf-workflow.test.ts
│   └── routes/
└── scripts/
    ├── smoke-test.ts              # E2E tests against live deployment
    └── sample-query.ts            # In-process test script
```

---

## 17. Implementation Status

### Completed (v2.1)

| Feature | Status | Notes |
|---|---|---|
| SupervisorAgent | ✅ Implemented | Custom agentic loop, not Mastra |
| ExecutionRouter | ✅ Implemented | 5 layers + codegen fallback |
| WorkflowEngine | ✅ Implemented | Pause/resume, KV + DB state |
| DAGWorkflowEngine | ✅ Implemented | Parallel execution via Kahn's algorithm |
| SkillWorkflow | ✅ POC | CF Workflows with durable steps |
| ConversationManager | ✅ Implemented | Multi-turn memory in KV |
| DaytonaClient | ✅ Implemented | @daytonaio/sdk integration |
| RunicsClient | ✅ Implemented | KV-cached skill discovery |
| LLMClient | ✅ Implemented | Proxy routing, multi-turn tool calling |
| API key auth | ✅ Implemented | DB + KV cache, scopes |
| Rate limiting | ✅ Implemented | 30 req/min per tenant |
| Observability | ✅ Implemented | Logger + Analytics Engine metrics |
| AI SDK streaming | ✅ Implemented | UI Message Stream v1 |
| Forge decoupling | ✅ Complete | No internal queues |
| Cognium decoupling | ✅ Complete | Stateless trust checker only |

### Pending

| Feature | Priority | Notes |
|---|---|---|
| Webhook callbacks | P1 | Long-running workflow notifications |
| Token-level streaming | P1 | Stream LLM tokens to client |
| Production CORS | P2 | Currently allows all origins |
| Per-key rate limits | P2 | Currently per-tenant |
| Activepieces integration | P3 | Triggers & events |
| Browser Rendering | P3 | Stagehand/Playwright integration |

### Test Coverage

- 558 unit tests passing (vitest)
- E2E smoke test: 8 passed, 1 warn (Runics unavailable)
- Live verified: codegen pipeline end-to-end
