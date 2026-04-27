# Cortex Specification — v2.0

> **Applies to:** `cortex-specification.md` — full rewrite, supersedes v1.5
> **Version:** 2.0 · April 2026
> **Status:** Architecture locked. Implementation pending.
> **Company:** Cognium Labs
> **Stack:** TypeScript · Cloudflare Workers · Cloudflare Workflows · Cloudflare Sandbox SDK · Browser Rendering · KV · Queues
> **Companion docs:** `cognium-architecture-overview.md` · `runics-dag-specification.md` · `runics-unified-architecture.md` · `api-key-middleware-specification.md` · `bombastic-specification.md`
>
> **v2.0 changes:** Cortex is now a durable workflow engine built on Cloudflare Workflows. Mastra extracted to a stateless reasoning wrapper (separate Worker, service binding). Forge absorbed as an internal async subsystem. Activepieces demoted to code dependency. DAG-based execution using @runics/dag format. Dual mode: conversational (ephemeral) and workflow (durable). Daytona replaced by CF Sandbox SDK. Dynamic Workers for lightweight execution. API surface expanded with workflow CRUD and webhook routing.

---

## 1. What Cortex Is

Cortex is the execution spine of Cognium Labs. It is a durable workflow engine that executes DAGs of skills, coordinating between skill discovery (Runics), trust verification (cached from Cognium), LLM reasoning (Mastra wrapper), and external services (Activepieces connectors).

Every product (Clove, CoStaff, ControlDeck, Akrobatos) calls Cortex to execute work. Cortex owns the lifecycle of every workflow: instantiation, step execution, approval pausing, error handling, and completion notification.

**What Cortex is NOT:**
- Not an LLM orchestration library (that's the Mastra wrapper)
- Not a skill registry (that's Runics)
- Not a trust verifier (that's Cognium, called by Runics at ingestion)
- Not a connector platform (that's Activepieces, imported as code)
- Not a product state manager (that's @specifica/store in product DOs)

---

## 2. Architecture

```
Product DOs ──HTTP──▶ Cortex API Worker ──binding──▶ CortexDAGExecutor
                              │                        (CF Workflow)
                              │                            │
                    ◀──WebSocket──────────────────────────┘
                                                           │
                              ┌─────────────────┬──────────┼──────────┐
                              │                 │          │          │
                         Mastra wrapper    Runics API   Sandbox    Browser
                        (service binding)  (HTTP)       SDK       Rendering
                              │
                         LLM Proxy
                        (external)
```

### Internal Components

| Component | Deployment | Connection | Purpose |
|---|---|---|---|
| Cortex API Worker | CF Worker | Public HTTP | Routes requests, manages instances, handles webhooks |
| CortexDAGExecutor | CF Workflow | Binding from API Worker | Executes DAGs durably |
| Mastra wrapper | Separate CF Worker | Service binding (zero-latency) | LLM reasoning on demand |
| Forge | Internal queue consumer | CF Queue within Cortex | Trace capture → skill distillation |

---

## 3. Dual Execution Mode

### 3.1 Conversational Mode

For real-time chat. Ephemeral, no durable state. Direct to Mastra wrapper.

**When:** product sends `POST /v1/chat` — user is typing in scoped chat, expecting immediate response.

**Flow:** API Worker → Mastra wrapper → LLM reasons → stream response to product.

**Promotion:** if the LLM response includes an `emit_decomposition` call, Cortex auto-promotes to workflow mode. The API Worker instantiates a CF Workflow with the DAG, and the response stream continues while the workflow executes in the background.

### 3.2 Workflow Mode

For durable multi-step execution. CF Workflow instance per DAG.

**When:** product sends `POST /v1/workflows` with a DAG, or conversational mode auto-promotes.

**Flow:** API Worker creates CF Workflow instance → CortexDAGExecutor runs → steps execute per DAG → product notified on completion/error via WebSocket.

---

## 4. API Surface

### 4.1 Endpoints

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/v1/chat` | Conversational mode — stream LLM response | API key (cortex scope) |
| `POST` | `/v1/workflows` | Create a durable workflow instance | API key (cortex scope) |
| `GET` | `/v1/workflows/:id` | Query workflow instance state | API key (cortex scope) |
| `POST` | `/v1/workflows/:id/terminate` | Terminate a running workflow | API key (cortex scope) |
| `POST` | `/v1/approvals/:id/approve` | Resume a paused workflow step | API key (cortex scope) |
| `POST` | `/v1/approvals/:id/reject` | Cancel a paused workflow step | API key (cortex scope) |
| `POST` | `/v1/webhooks/:tenantId/:workflowId` | External event delivery | Webhook signature |
| `GET` | `/health` | Service health | Public |

### 4.2 POST /v1/chat

Conversational mode. Backward compatible with v1.5.

```typescript
interface ChatRequest {
  productId: string;
  userId: string;
  conversationId?: string;
  messages: Message[];
  context?: Record<string, unknown>;
  model?: string;
}
```

Returns: AI SDK Data Stream Protocol (streaming response).

If the LLM calls `emit_decomposition`, the response includes a `workflow_created` data part:

```typescript
interface WorkflowCreatedEvent {
  type: 'workflow_created';
  workflowId: string;
  dag: WorkflowDAG;
  status: 'running';
}
```

### 4.3 POST /v1/workflows

Create a durable workflow instance from a DAG.

```typescript
interface CreateWorkflowRequest {
  productId: string;
  tenantId: string;
  userId: string;
  dag: WorkflowDAG;              // @runics/dag format
  productItemId?: string;        // back-reference to product DO item
  callbackUrl?: string;          // product DO URL for completion/error notification
}

interface CreateWorkflowResponse {
  workflowId: string;
  status: 'running' | 'queued';
  dag: WorkflowDAG;
  createdAt: string;
}
```

### 4.4 GET /v1/workflows/:id

```typescript
interface WorkflowStatus {
  workflowId: string;
  status: 'running' | 'waiting' | 'complete' | 'errored' | 'terminated';
  currentStep?: string;
  completedSteps: string[];
  pendingApprovals: ApprovalRequest[];
  outputs: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 4.5 POST /v1/webhooks/:tenantId/:workflowId

External event delivery. Routes to the CF Workflow instance via `sendEvent()`. This endpoint is called by external services (PagerDuty, GitHub, Stripe) that do not have Cognium Labs API keys.

```typescript
interface WebhookPayload {
  type: string;          // event type — matched against step.waitForEvent
  payload: unknown;      // event data
}
```

**Authentication (separate from API key middleware):**

Webhook auth uses HMAC-SHA256 signatures, not API keys. Each tenant has a webhook secret stored in KV (`webhook-secret:{tenantId}`). The external service includes the signature in headers.

```typescript
// Webhook validation
const signature = c.req.header('X-Cognium-Signature');
const timestamp = c.req.header('X-Cognium-Timestamp');
const body = await c.req.text();

// Validate timestamp (prevent replay attacks — reject if >5 minutes old)
const age = Date.now() - parseInt(timestamp);
if (age > 300_000) return c.json({ error: 'Timestamp too old' }, 401);

// Validate signature
const secret = await c.env.WEBHOOK_SECRETS.get(`webhook-secret:${tenantId}`);
const expected = await hmacSHA256(`${timestamp}.${body}`, secret);
if (signature !== expected) return c.json({ error: 'Invalid signature' }, 401);

// Validate tenant owns this workflow
const instance = await c.env.DAG_EXECUTOR.get(workflowId);
const status = await instance.status();
if (status.params?.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);

// Deliver event
await instance.sendEvent({ type: payload.type, payload: payload.payload });
```

**Webhook secret management:** per-tenant secrets are created during tenant onboarding (via the API key management endpoints). Tenants configure the secret in their external service's webhook settings.

---

## 5. CortexDAGExecutor — The Workflow Class

A single CF Workflow class that executes any DAG from Runics or from inline definition.

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { toExecutionLayers, resolveInputs, evaluateCondition } from '@runics/dag';

interface DAGParams {
  dag: WorkflowDAG;
  tenantId: string;
  productId: string;
  userId: string;
  productItemId?: string;
  callbackUrl?: string;
  sessionConfig: CortexSessionConfig;
}

export class CortexDAGExecutor extends WorkflowEntrypoint<Env, DAGParams> {
  async run(event: WorkflowEvent<DAGParams>, step: WorkflowStep) {
    const { dag, tenantId, sessionConfig } = event.payload;
    const layers = toExecutionLayers(dag);
    const outputs: Record<string, unknown> = {};

    for (const layer of layers) {
      // Each layer runs as a persisted step (survives hibernation)
      const layerOutputs = await step.do(
        `layer-${layer.index}`,
        async () => {
          const results: Record<string, unknown> = {};

          // All steps in layer can run in parallel
          await Promise.all(
            layer.stepIds.map(async (stepId) => {
              const dagStep = dag.steps.find(s => s.id === stepId)!;

              // Condition check
              if (dagStep.condition) {
                const shouldRun = evaluateCondition(dagStep.condition, outputs);
                if (!shouldRun) {
                  results[stepId] = { skipped: true, reason: 'condition_false' };
                  return;
                }
              }

              // Approval gate
              if (dagStep.requiresApproval) {
                const approval = await step.waitForEvent(
                  `approval-${stepId}`,
                  { type: `approval-${stepId}`, timeout: '30 minutes' }
                );
                if (approval?.payload?.decision === 'reject') {
                  results[stepId] = { skipped: true, reason: 'rejected' };
                  return;
                }
              }

              // Resolve skill
              const skill = await this.resolveSkill(dagStep, sessionConfig);
              if (!skill) {
                if (dagStep.onError === 'skip') {
                  results[stepId] = { skipped: true, reason: 'skill_not_found' };
                  return;
                }
                throw new Error(`Skill not found for step "${stepId}"`);
              }

              // Trust check
              if (skill.trustScore < sessionConfig.minTrust) {
                throw new Error(
                  `Skill "${skill.slug}" trust ${skill.trustScore} below minimum ${sessionConfig.minTrust}`
                );
              }

              // Resolve inputs
              const inputs = resolveInputs(dagStep, outputs);

              // Execute
              const result = await this.executeSkill(skill, inputs, tenantId);
              results[stepId] = result;
            })
          );

          return results;
        },
        dagStep?.retry ? {
          retries: {
            limit: dagStep.retry.count,
            delay: `${dagStep.retry.delayMs} milliseconds`,
            backoff: dagStep.retry.backoff,
          }
        } : undefined
      );

      // Merge layer outputs into accumulated outputs
      Object.assign(outputs, layerOutputs);
    }

    // Notify product on completion
    await step.do('notify-completion', async () => {
      if (event.payload.callbackUrl) {
        await fetch(event.payload.callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'workflow_complete',
            workflowId: event.id,
            outputs,
          }),
        });
      }
    });

    // Forge trace capture (fire-and-forget via queue)
    await step.do('capture-trace', async () => {
      await this.env.FORGE_QUEUE.send({
        workflowId: event.id,
        dag: event.payload.dag,
        outputs,
        tenantId,
        userId: event.payload.userId,
        completedAt: new Date().toISOString(),
      });
    });

    return outputs;
  }

  // ... resolveSkill, executeSkill methods below
}
```

**Note:** The code above is illustrative. The actual implementation must handle CF Workflows replay semantics carefully:

1. **Step return values are the only persisted state.** In-memory variables (like `outputs`) are lost on hibernation. However, CF Workflows replays completed steps instantly (returning cached results) on restart, so `outputs` is reconstructed from cached step returns during replay.

2. **Parallel steps within a layer.** Wrapping an entire layer in one `step.do()` means the whole layer retries together if one step fails. For independent per-step retry, each parallel step should be its own `step.do()` call inside a `Promise.all()`:
```typescript
// Better pattern: individual step.do() calls inside Promise.all()
const results = await Promise.all(
  layer.stepIds.map(stepId =>
    step.do(`step-${stepId}`, { retries: stepRetryConfig }, async () => {
      // ... resolve skill, check trust, execute
    })
  )
);
```

3. **Step names must be deterministic.** Step IDs come from the DAG definition — they are deterministic by design. Never use timestamps, random values, or runtime-dependent strings in step names.

4. **Large step outputs.** Step return values are capped at 1 MiB. For large results (API responses, browser screenshots), store in R2 and return the reference key.

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

## 7. Runtime Dispatch

When a skill is resolved, Cortex routes execution based on `runtime_env`:

```typescript
async executeSkill(
  skill: SkillMetadata,
  inputs: Record<string, unknown>,
  tenantId: string,
): Promise<unknown> {
  // Credential injection for authenticated skills
  const credentials = skill.authRequirements
    ? await this.getCredentials(tenantId, skill.id)
    : undefined;

  switch (skill.runtimeEnv) {
    case 'llm':
      return this.executeLLM(skill, inputs);

    case 'api':
      return this.executeAPI(skill, inputs, credentials);

    case 'browser':
      return this.executeBrowser(skill, inputs, credentials);

    case 'vm':
      return this.executeVM(skill, inputs, credentials);

    case 'local':
      return this.executeLocal(skill, inputs, tenantId);

    default:
      throw new Error(`Unknown runtime_env: ${skill.runtimeEnv}`);
  }
}
```

### 7.1 LLM Execution

Inject `skill_md` into LLM context. Call Mastra wrapper.

```typescript
async executeLLM(skill: SkillMetadata, inputs: Record<string, unknown>) {
  const response = await this.env.MASTRA_WRAPPER.fetch('/v1/reason', {
    method: 'POST',
    body: JSON.stringify({
      systemPromptAppend: skill.skillMd,
      messages: [{ role: 'user', content: JSON.stringify(inputs) }],
    }),
  });
  return response.json();
}
```

### 7.2 API Execution

HTTP call to MCP server or external API.

```typescript
async executeAPI(skill: SkillMetadata, inputs: Record<string, unknown>, credentials?: Credentials) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials?.headers) Object.assign(headers, credentials.headers);

  const response = await fetch(skill.mcpUrl!, {
    method: 'POST',
    headers,
    body: JSON.stringify(inputs),
  });
  return response.json();
}
```

### 7.3 Browser Execution

CF Browser Rendering for interactive web sessions.

```typescript
async executeBrowser(skill: SkillMetadata, inputs: Record<string, unknown>, credentials?: Credentials) {
  const browser = await this.env.BROWSER.newPage();
  // Execute browser skill instructions via Stagehand or Playwright
  // Skill's skill_md contains browser interaction instructions
  // Returns: action results, page state summary, screenshots as R2 artifacts
}
```

### 7.4 VM Execution

CF Sandbox SDK for heavy execution, Dynamic Workers for lightweight.

```typescript
async executeVM(skill: SkillMetadata, inputs: Record<string, unknown>, credentials?: Credentials) {
  // Determine: Sandbox (heavy) vs Dynamic Worker (light)
  const needsFullEnv = skill.capabilitiesRequired?.includes('git')
    || skill.capabilitiesRequired?.includes('pip')
    || skill.capabilitiesRequired?.includes('npm');

  if (needsFullEnv) {
    // CF Sandbox SDK — full Linux environment
    const sandbox = await this.env.SANDBOX.create();
    // Clone code, install deps, execute, return results
    const result = await sandbox.exec(skill.entryCommand, { env: credentials?.envVars });
    return { stdout: result.stdout, exitCode: result.exitCode };
  } else {
    // Dynamic Workers — lightweight V8 isolate (evaluate for future)
    // For now, fall through to Sandbox
    const sandbox = await this.env.SANDBOX.create();
    const result = await sandbox.runCode(skill.codeBundle, { input: inputs });
    return result;
  }
}
```

### 7.5 Local Execution

Forward to user's machine via Cloudflare Tunnel.

```typescript
async executeLocal(skill: SkillMetadata, inputs: Record<string, unknown>, tenantId: string) {
  const tunnelUrl = await this.getTunnelUrl(tenantId);
  const response = await fetch(`${tunnelUrl}/execute`, {
    method: 'POST',
    body: JSON.stringify({ skillId: skill.id, inputs }),
  });
  return response.json();
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

## 10. Forge — Internal Trace Capture

### 10.1 What Forge Does

Captures execution traces from completed workflows. Distills them into reusable skills (published to Runics). Skills only — not knowledge artifacts.

### 10.2 How It Works

1. CortexDAGExecutor's final step sends trace to `FORGE_QUEUE`
2. Forge queue consumer processes traces asynchronously
3. Reusability judge evaluates trace quality
4. If reusable, distiller generates a new skill definition
5. Skill published to Runics as `source: 'forge'`

### 10.3 Trace Schema

```typescript
interface ForgeTrace {
  workflowId: string;
  dag: WorkflowDAG;
  outputs: Record<string, unknown>;
  tenantId: string;
  userId: string;
  completedAt: string;
  steps: ForgeTraceStep[];
}

interface ForgeTraceStep {
  stepId: string;
  skillSlug: string;
  skillVersion: string;
  runtimeEnv: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  success: boolean;
}
```

### 10.4 DAG vs Trace

The DAG is built by Cortex at decomposition time — it's the *plan*. The trace is captured after execution — it's *what happened*. When a user saves a workflow, Cortex publishes the DAG (the plan that worked). Forge captures the trace for analytics and quality improvement.

---

## 11. Mastra Wrapper

### 11.1 What It Is

A stateless LLM reasoning service. Separate Cloudflare Worker connected to Cortex via service binding.

### 11.2 What It Does

- Mastra orchestration with system prompt + model routing
- Conversation memory (per userId + conversationId via Mastra sessions)
- `emit_decomposition` tool — expanded to emit DAG structure with dependencies and input mappings. See `runics-dag-specification.md` §5.1 for the complete tool schema. The LLM returns steps with `dependsOn` hints and `skillQuery`; Cortex's DAG builder (§5.2 in the DAG spec) resolves these into a proper `WorkflowDAG`.
- LLM calls routed through existing LLM proxy

### 11.3 API (Internal Only)

```typescript
// Called by Cortex via service binding — not a public API
interface MastraRequest {
  productId: string;
  userId: string;
  conversationId: string;
  messages: Message[];
  context?: Record<string, unknown>;
  model?: string;
  systemPromptAppend?: string;  // for skill_md injection
}
```

### 11.4 Size

~300 lines. Mastra initialization + system prompt + model map + the `emit_decomposition` tool definition. No execution logic, no approval state, no skill dispatch.

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
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts                    # Worker entry, Hono router
│   ├── workflows/
│   │   └── dag-executor.ts         # CortexDAGExecutor (CF Workflow class)
│   ├── runtime/
│   │   ├── dispatch.ts             # Runtime dispatch by runtime_env
│   │   ├── llm.ts                  # LLM execution (via Mastra)
│   │   ├── api.ts                  # API/MCP execution
│   │   ├── browser.ts              # Browser Rendering execution
│   │   ├── vm.ts                   # Sandbox SDK / Dynamic Workers
│   │   └── local.ts                # Local tunnel execution
│   ├── api/
│   │   ├── chat.ts                 # POST /v1/chat handler
│   │   ├── workflows.ts           # Workflow CRUD handlers
│   │   ├── approvals.ts           # Approval handlers
│   │   └── webhooks.ts            # Webhook routing handler
│   ├── forge/
│   │   ├── consumer.ts            # Queue consumer for traces
│   │   ├── judge.ts               # Reusability judge
│   │   └── distiller.ts           # Trace → skill distillation
│   ├── credentials/
│   │   └── vault.ts               # KV credential management
│   ├── config/
│   │   └── products.ts            # Product session configs
│   └── types.ts                   # Shared types
├── tests/
│   ├── dag-executor.test.ts
│   ├── runtime.test.ts
│   ├── api.test.ts
│   └── forge.test.ts
└── mastra-wrapper/                # Separate Worker
    ├── wrangler.toml
    ├── src/
    │   ├── index.ts               # Mastra init + routing
    │   ├── tools.ts               # emit_decomposition tool
    │   └── config.ts              # System prompts, model maps
    └── tests/
        └── reasoning.test.ts
```

---

## 17. Migration from v1.5

| v1.5 Component | v2.0 Equivalent | Action |
|---|---|---|
| Mastra orchestration in Cortex | Mastra wrapper (separate Worker) | Extract |
| `invokeSkill` dispatch | `executeSkill` in DAG executor | Rewrite |
| Runics search integration | Called from `resolveSkill` in executor | Move |
| Cognium trust gating | Read cached score from skill metadata | Simplify |
| Approval flow via DO | `step.waitForEvent` + `sendEvent` | Replace |
| Forge as peer service | Internal queue consumer | Absorb |
| Credential vault (KV) | Unchanged | Keep |
| Session memory (DO) | Mastra sessions in wrapper | Move |
| `POST /v1/chat` | Backward compatible | Keep |
| Execution dispatch table | Updated with Sandbox SDK + Dynamic Workers | Update |
