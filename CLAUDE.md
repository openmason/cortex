# Cortex — Shared Agent Runtime

## Project Overview
Cloudflare Workers-based agent runtime that orchestrates skill discovery, planning, and execution. Built with Hono, Drizzle ORM, Neon Postgres via Hyperdrive.

## Architecture
- **Supervisor Agent** (`src/agents/supervisor.ts`) — LLM-powered agentic loop with tool calling (findSkill, checkPolicy, buildPlan, invokeSkill)
- **Workflow Engine** (`src/workflow/engine.ts`) — orchestrates multi-step skill execution with pause/resume, input mapping ($prev, $step.N). Accepts optional `LLMClient` for codegen fallback in workflow steps.
- **DAG Workflow Engine** (`src/workflow/dag-engine.ts`) — executes DAG-based workflows with parallel layer execution, condition evaluation, approval gates, and retry policies
- **DAG Utilities** (`src/workflow/dag.ts`) — Kahn's algorithm for `toDAGExecutionLayers()`, condition evaluation, DAG validation, plan↔DAG conversion
- **CF Workflow POC** (`src/workflow/cf-workflow.ts`) — Cloudflare Workflows integration for durable skill execution with automatic checkpointing, retries, and state recovery
- **Execution Router** (`src/execution/router.ts`) — dispatches to 5 layers: mcp-remote, instructions, worker, container, composite. Includes codegen fallback for skills with no executable bundle.
- **Daytona Client** (`src/clients/daytona.ts`) — Uses `@daytonaio/sdk` for sandbox execution. Key methods: `execute()` (shell commands), `runCode()` (direct code execution via `codeRun()`), `cleanup()` (orphaned sandbox removal).
- **Policy Engine** (`src/policy/engine.ts`) — tenant-level trust checks, appetite thresholds, sensitive categories
- **DB Repository** (`src/db/repository.ts`) — Drizzle/postgres.js/Hyperdrive for durable workflow records and API key storage

## Service Boundaries (Important)
Cortex is the **runtime only**. It orchestrates and executes. It does NOT own trust scanning or skill generation.

- **Cortex → Runics**: Skill discovery (`findSkill`), skill metadata, trust scores (returned by Runics). Cortex reads trust scores from Runics; it never computes or updates them.
- **Cortex → Daytona**: Container execution (L3 layer). Direct integration — Cortex calls Daytona to run sandboxed skills.
- **Cortex does NOT talk to Cognium directly**. Trust scoring and security scanning are Runics' responsibility. Runics talks to Cognium internally.
- **Cortex does NOT embed Forge**. Forge is an independent service that subscribes to workflow events. Cortex emits workflow completion events; Forge consumes them, evaluates traces, and publishes skills to Runics.

```
Cortex (runtime) ──→ Runics (registry, includes trust scores)
                 ──→ Daytona (container execution)
                 ──→ emits workflow events (queue/webhook)

Forge (independent) ──→ subscribes to workflow events
                    ──→ publishes skills to Runics

Runics (registry) ──→ Cognium (internal trust/scanning)
```

## LLM Proxy
- URL: `https://llmproxy.xus.one` (OpenAI-compatible, routed via LiteLLM → OpenRouter / Cloudflare Workers AI)
- API Key: set as `LLMPROXY_API_KEY` secret
- Default model (`LLM_MODEL`): `cognium/gpt-oss-120b` (free, Cloudflare Workers AI — supports tool calling via `/v1/chat/completions`)
- Tool call model (`TOOL_CALL_MODEL`): optional override. Not needed when `gpt-oss-120b` handles both chat and tool calling.
- **Model selection**: `getToolCallModel()` queries proxy capabilities (KV-cached 5 min), selects best tool-capable model. `TOOL_CALL_MODEL` env var is an optional override.
- **No-tool-call fallback**: `handleRequest` and `handleRequestStreaming` check `hasToolCapableModel()` first. If no tool-capable model is available, they automatically fall back to `handleRequestDirect` (Runics keyword search → execute, no LLM planning loop).
- **Model fallback**: Proxy handles model-level fallback chains (e.g. claude-sonnet → gemini-pro on 402). No client-side retry in `agentLoop`.
- **OpenRouter compat**: Handled at the proxy layer (v0.5.2+) — response normalization, input message normalization, `content:null` → `""` conversion. All models work for multi-turn tool calling.
- **Multi-turn tool calling**: `agentLoop` validates tool call structure (id, function name, arguments format), accepts `finish_reason` variants (`tool_calls`, `tool_call`, `function_call`) as safety net, normalizes arguments from object→string if provider returns non-string, skips malformed tool calls gracefully.
- **Request correlation**: Sends `X-Request-ID` on outgoing proxy calls, reads `X-Proxy-Request-ID` from responses.
- **Cost tracking**: `usage.cost` from proxy responses written to Analytics Engine `double3` and logged per LLM call.
- Models constant in `src/clients/llm.ts` MODELS object (11 models: 3 premium, 3 budget, 3 specialized, 2 Cloudflare)
- **Available models** (all via OpenRouter unless noted):
  - Premium: `claude-opus-latest` (Opus 4.6, $5/$25), `openai-gpt-latest` (GPT-5.2, $1.75/$14), `claude-sonnet-latest` (Sonnet 4.5, ~$1/$5)
  - Budget: `grok-code-latest` (Grok Code Fast 1, $0.20/$0.50), `deepseek-latest` (V3.2, $0.24/$0.38), `claude-haiku-latest` (Haiku 4.5, $0.25/$1.25)
  - Specialized: `gemini-pro-latest` (1M context, $2/$12), `z-ai-latest` (GLM-5, $0.30/$2.55), `minimax-m-latest` (M2.5, $0.30/$1.20)
  - Free: `gpt-oss-120b` (Cloudflare Workers AI, tool calling supported), `qwen-2.5-coder` (Cloudflare Workers AI, no tool calling)

## Infrastructure (Provisioned)
- **Neon DB**: Connection string in `.dev.vars` / wrangler secret `DATABASE_URL`
- **Hyperdrive**: ID in `wrangler.toml`
- **KV SESSION_CACHE**: ID in `wrangler.toml`
- **KV WORKFLOW_STATE**: ID in `wrangler.toml`
- **R2 Bucket**: `cortex-artifacts`
- **Service Binding**: `RUNICS_SERVICE` → `runics` worker

## Deploy Status
- **Live at**: `https://cortex.phantoms.workers.dev`
- Secrets set: LLMPROXY_API_KEY, DAYTONA_API_KEY (placeholder), DATABASE_URL, ADMIN_SECRET
- Schema already pushed to Neon DB (5 tables: workflow_sessions, step_executions, execution_traces, tenant_policies, api_keys)
- Durable Objects use `new_sqlite_classes` migration (required for free plan)

## Auth & Scopes
- Bearer API key auth on all `/v1/*` routes via `src/middleware/auth.ts`
- **API key storage**: Neon DB (`api_keys` table) is source of truth; KV is a 5-min read-through cache
  - Write path: DB first → KV write-through (best-effort)
  - Read path (auth): KV cache → DB fallback → backfill KV
  - Revoke: soft-delete in DB (`revokedAt` timestamp) + delete from KV
- Key format: `ctx_` + 32 hex chars
- Admin routes (`/admin/*`) protected by `ADMIN_SECRET` env var
- Create keys: `POST /admin/api-keys` with `{tenantId, userId, product, scopes?}`
- Revoke keys: `DELETE /admin/api-keys/:key`
- **Scope enforcement** via `requireScope()` middleware:
  - `workflows` — `/v1/workflows/*`, `/v1/chat`, `/v1/approvals/*` (primary scope for workflow operations)
  - `run` — deprecated alias for `workflows` (backward compatibility only)
  - `sessions` — `/v1/sessions/*`
  - `skills` — `/v1/skills/*`
  - `models` — no scope required (open to any authenticated key)
- Valid scopes: `["workflows", "run", "sessions", "skills", "models"]`
- Default scopes on new keys: `["workflows", "sessions"]`
- **Visibility enforcement**: `userId` is passed to Runics in `findSkill` and `listComposites` for private skill filtering

## API Endpoints
- `GET /` — Service info
- `GET /health` — Health check (KV + DB/Hyperdrive + Runics)
- `POST /v1/workflows` — Start workflow (primary; JSON response; add `"stream": true` or `Accept: text/event-stream` for SSE)
- `POST /v1/workflows/stream` — Start workflow with SSE streaming (primary)
- `GET /v1/workflows/:id` — Workflow status (primary)
- `POST /v1/workflows/:id/resume` — Resume paused workflow (primary)
- `POST /v1/workflows/:id/terminate` — Terminate running/paused workflow (primary)
- `POST /v1/workflows/:id/save` — Save workflow as skill (primary)
- `POST /v1/run` — **DEPRECATED** alias for `/v1/workflows` (backward compatibility)
- `POST /v1/run/stream` — **DEPRECATED** alias for `/v1/workflows/stream`
- `GET /v1/run/:id` — **DEPRECATED** alias for `/v1/workflows/:id`
- `POST /v1/run/:id/resume` — **DEPRECATED** alias for `/v1/workflows/:id/resume`
- `POST /v1/run/:id/terminate` — **DEPRECATED** alias for `/v1/workflows/:id/terminate`
- `POST /v1/run/:id/save` — **DEPRECATED** alias for `/v1/workflows/:id/save`
- `GET /v1/models` — List available LLM models
- `GET /v1/sessions` — List sessions (tenant-scoped, paginated)
- `GET /v1/sessions/:id` — Session detail with step executions
- `GET /v1/sessions/:id/trace` — Execution trace (consumed by Forge independently)
- `GET /v1/sessions/conversations` — List conversations from KV (sorted by recent activity)
- `GET /v1/sessions/conversations/:id` — Get full conversation with messages
- `DELETE /v1/sessions/conversations/:id` — Delete a conversation
- `GET /v1/skills/composites` — List composite skills (tenant-scoped, paginated)
- `GET /v1/skills/composites/:slug` — Composite detail with composition steps
- `PATCH /v1/skills/composites/:slug` — Update composite metadata
- `POST /v1/skills/composites/:slug/deprecate` — Deprecate a composite
- `POST /v1/skills/composites/:slug/fork` — Fork a composite
- `POST /v1/chat` — Clove-compatible chat (accepts `productId + messages` with parts, always streams AI SDK v5+ SSE)
- `POST /v1/approvals/:id/approve` — Approve a paused workflow (alias for resume)
- `POST /v1/approvals/:id/reject` — Reject a paused workflow (alias for resume with approved=false)
- `GET /v1/analytics/usage` — Usage analytics for tenant (7d window, daily + per-endpoint breakdowns)
- `POST /admin/api-keys` — Create API key
- `DELETE /admin/api-keys/:key` — Revoke API key
- `PUT /admin/policies` — Upsert tenant policy
- `GET /admin/policies/:tenantId/:product` — Get tenant policy

## Codegen Fallback
When a skill has no executable bundle (no `mcpUrl`, no `skillMd`, no `r2BundleKey`), the ExecutionRouter uses LLM-generated code executed in a Daytona sandbox:
1. LLM generates a self-contained Node.js script based on skill description + input (temperature 0, strict "raw JS only" system message)
2. Code is executed via `DaytonaClient.runCode()` which uses `sandbox.process.codeRun()` from `@daytonaio/sdk`
3. On failure, the error is fed back to the LLM for a single retry attempt
4. `stripFences()` aggressively removes markdown code fences from LLM output
- The codegen path is available in both `invokeSkill` (direct execution) and `buildPlan` (multi-step workflow) flows
- Requires `LLMClient` to be passed through: Supervisor → ToolExecutor → ExecutionRouter, and Supervisor → WorkflowEngine → ExecutionRouter

## Daytona Integration
- SDK: `@daytonaio/sdk` (direct API, not REST)
- `DaytonaClient.execute()` — shell command execution in sandbox (with structured logging and `sandbox_exec` metrics)
- `DaytonaClient.runCode()` — direct code execution via `codeRun()` (used by codegen fallback)
- `DaytonaClient.cleanup()` — lists and deletes all sandboxes (called by cron)
- Constructor accepts optional `Logger` and `Metrics` for observability; passed from `ExecutionRouter` and cron handler
- Target region: `DAYTONA_TARGET` env var (default: `us`)
- Sandbox lifecycle: create → execute → delete (always cleaned up in `finally` block)

## Rate Limiting
- KV-based sliding window: 30 requests/minute per API key
- Applied to `/v1/workflows`, `/v1/workflows/*`, `/v1/run`, `/v1/run/*`, and `/v1/chat` routes
- All KV writes are non-blocking (`waitUntil` + `try/catch`) to avoid blocking on KV daily write limits
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- Rate limit key format: `ratelimit:key:{apiKeyPrefix}:{window}` (first 12 chars of API key)

## Runics Skill Caching
- `findSkill` results cached in KV for 5 minutes (key: `runics:search:{query}:{appetite}`)
- `getSkill` results cached in KV for 10 minutes (key: `runics:skill:{slug}:{version}`)
- All cache writes are best-effort (wrapped in try/catch)

## SSE Streaming
- `POST /v1/workflows/stream` returns Server-Sent Events (dedicated streaming endpoint)
- `POST /v1/workflows` with `"stream": true` in body or `Accept: text/event-stream` header also returns SSE (unified endpoint)
- Event types: `planning`, `tool_call`, `tool_result`, `step_start`, `step_complete`, `workflow_complete`, `error`, `done`, `conversation`
- `done` event includes `usage: { totalTokens, totalCost }` for cost tracking

## DAG Workflows (Spec v2.0)
`POST /v1/workflows` accepts two formats: **DAG-based** (parallel execution) or **prompt-based** (LLM-planned).

### DAG Request Format
```json
{
  "dag": {
    "id": "optional-workflow-id",
    "name": "Security Audit Pipeline",
    "description": "Runs secrets scan, dependency audit, and Cognium scan in parallel",
    "mode": "full_auto",
    "steps": [
      {
        "id": "secrets",
        "binding": "static",
        "skillRef": "secrets-scan@1.0.0",
        "inputMapping": { "repoUrl": "$context.repoUrl" },
        "onError": "skip"
      },
      {
        "id": "deps",
        "binding": "static",
        "skillRef": "dependency-audit@latest",
        "inputMapping": { "repoUrl": "$context.repoUrl" },
        "onError": "skip"
      },
      {
        "id": "cognium",
        "binding": "dynamic",
        "skillRef": "run security scan on the codebase",
        "dependsOn": ["secrets", "deps"],
        "condition": { "type": "expression", "expr": "$step.secrets.status === 'completed'" },
        "onError": "fail",
        "retry": { "count": 2, "delayMs": 1000, "backoff": "exponential" }
      },
      {
        "id": "review",
        "dependsOn": ["cognium"],
        "binding": "static",
        "skillRef": "create-pr@1.0.0",
        "requiresApproval": true,
        "onError": "fail"
      }
    ]
  },
  "productId": "controlcenter",
  "callbackUrl": "https://my-app.com/webhook/workflow-done"
}
```

### DAG Step Fields
- `id` — unique step identifier (required)
- `binding` — `"static"` (slug@version) or `"dynamic"` (natural language query)
- `skillRef` — skill reference: `"slug@version"` for static, natural language for dynamic
- `dependsOn` — array of step IDs that must complete before this step runs
- `inputMapping` — template expressions: `$prev`, `$step.N.field`, `$context.field` (supports nested objects/arrays)
- `condition` — `{ type: "expression", expr: "..." }` — step runs only if evaluates to true
- `onError` — `"fail"` (abort workflow), `"skip"` (continue), `"retry"` (use retry config)
- `retry` — `{ count, delayMs, backoff: "linear"|"exponential" }` — required if onError="retry"
- `requiresApproval` — if true, workflow pauses for human approval before executing this step

### Workflow-Level Context (`$context`)
DAG requests accept a `context` object for workflow-level secrets and shared variables:
```json
{
  "dag": { "steps": [...] },
  "context": {
    "githubToken": "ghp_xxx",
    "awsCredentials": { "accessKey": "AKIA...", "secret": "..." }
  }
}
```

Steps reference context values in `inputMapping`:
```json
"inputMapping": {
  "token": "$context.githubToken",
  "headers": { "Authorization": "$context.awsCredentials.accessKey" }
}
```

- `$context` — entire context object
- `$context.key` — top-level key
- `$context.nested.path.value` — nested path (dot notation)
- Works recursively in nested objects and arrays within inputMapping

### Callback URL
DAG requests accept `callbackUrl` to receive a webhook when the workflow completes:
```json
{
  "dag": { "steps": [...] },
  "callbackUrl": "https://my-app.com/webhook/workflow-done"
}
```

On workflow completion or failure, Cortex POSTs:
```json
{
  "workflowId": "uuid",
  "status": "completed|failed",
  "outputs": { /* step outputs */ },
  "error": "optional error message",
  "startedAt": "2026-05-01T...",
  "completedAt": "2026-05-01T..."
}
```

- Fire-and-forget via `waitUntil` (doesn't block response)
- Fires on terminal states: `completed`, `failed`, `terminated`
- Does not fire on pause states

### DAG Response Format
```json
{
  "workflowId": "uuid",
  "status": "completed|running|paused_for_review|paused_at_step|failed",
  "dag": { /* original DAG with resolved skills */ },
  "outputs": {
    "secrets": { "status": "completed", "result": { /* skill output */ } },
    "deps": { "status": "completed", "result": { /* skill output */ } },
    "cognium": { "status": "completed", "result": { /* skill output */ } },
    "review": { "status": "paused", "reason": "approval_required" }
  },
  "createdAt": "2026-04-27T..."
}
```

### Execution Modes
- `full_auto` — execute all steps immediately, no pauses
- `review_before_run` — pause for approval before executing any step
- `step_by_step` — pause after each layer for incremental approval

### Parallel Execution
Steps with no `dependsOn` or whose dependencies have all completed run in parallel. The DAG engine uses Kahn's algorithm to build execution layers:
- Layer 0: steps with no dependencies (run in parallel)
- Layer 1: steps whose only dependencies are in layer 0 (run in parallel)
- etc.

### Approval Flow
When a step has `requiresApproval: true`, the workflow pauses with status `paused_for_review` and `pausedStepId` set. Resume via:
- `POST /v1/workflows/:id/resume` with `{ "approved": true }` to continue
- `POST /v1/approvals/:id/approve` (convenience alias)
- `POST /v1/approvals/:id/reject` to abort

## Tenant Policies
- Policy loading chain: KV cache (5 min TTL) → DB (`tenant_policies` table) → `defaultPolicy()` fallback
- Zero behavior change until a `tenant_policies` row is inserted
- Admin endpoints: `PUT /admin/policies`, `GET /admin/policies/:tenantId/:product`

## Workflow State Fallback
- `GET /v1/workflows/:id` uses `engine.loadState()`: KV cache → DB fallback (reconstructs `WorkflowState` from `workflow_sessions` row)
- `saveAsSkill` also uses `engine.loadState()` for the same fallback

## Workflow Timeout Enforcement
- Paused workflows (`paused_for_review`, `paused_at_step`) get `timeoutAt` set to `now + WORKFLOW_TIMEOUT_MS` (default 5 min)
- **Lazy check**: `GET /v1/workflows/:id` checks `timeoutAt` and transitions to `timed_out` if expired
- **Resume guard**: `engine.resume()` checks timeout before allowing execution
- **Cron sweep**: `*/5 * * * *` cron does two things:
  1. Lists `workflow:*` KV keys, expires any paused workflows past `timeoutAt`
  2. Calls `DaytonaClient.cleanup()` to delete orphaned sandboxes
- Backward compat: old states without `timeoutAt` are never lazily timed out

## CF Workflows POC
Experimental integration with Cloudflare Workflows for durable execution with automatic checkpointing.

- **SkillWorkflow** (`src/workflow/cf-workflow.ts`) — Executes a single skill with durable steps
  - `step.do("resolve-skill")` — Resolves skill from Runics with retry (3x, 5s delay, exponential backoff)
  - `step.do("execute-skill")` — Executes via ExecutionRouter with retry (3x, 10s delay, exponential backoff)
  - Automatic state persistence at each step boundary
  - Configurable timeouts (30s resolve, 5m execute)
- **Admin endpoints** for testing:
  - `POST /admin/workflows/skill` — Trigger a SkillWorkflow instance
  - `GET /admin/workflows/skill/:instanceId` — Get workflow status
- **wrangler.toml binding**: `[[workflows]] name="skill-workflow" binding="SKILL_WORKFLOW" class_name="SkillWorkflow"`
- **Next steps**: Implement DAGWorkflow that wraps DAGWorkflowEngine for full DAG durability

## Testing
- 558 unit tests passing across 32 test files (`npx vitest run`)
- Local dev tested with `npx wrangler dev` — health, models, and full run request all work
- E2E verified live: codegen pipeline working end-to-end (findSkill → invokeSkill → codegen → Daytona → result)
- E2E smoke test: `ADMIN_SECRET=<secret> npx tsx scripts/smoke-test.ts` (9 tests against live deployment)
- Sample query script: `scripts/sample-query.ts` (mocked, in-process)

## Key Files
- `src/index.ts` — Hono app, queue handler, cron handler (includes Daytona cleanup)
- `src/types.ts` — all shared types, Env, AppVariables, SSEEvent
- `src/middleware/auth.ts` — Bearer API key auth + rate limiting middleware
- `src/agents/supervisor.ts` — main request handler with LLM agentic loop + streaming variant
- `src/agents/tools.ts` — tool definitions and ToolExecutor (passes LLM to ExecutionRouter)
- `src/clients/llm.ts` — LLM proxy client (chat, agentLoop with model fallback, listModels)
- `src/clients/daytona.ts` — Daytona SDK client (execute, runCode, cleanup)
- `src/clients/runics.ts` — Runics client with KV caching (findSkill, getSkill, composites)
- `src/execution/router.ts` — Execution router with codegen fallback and retry
- `src/workflow/engine.ts` — workflow orchestration with DB persistence, SSE events, and LLM passthrough
- `src/workflow/dag-engine.ts` — DAG workflow executor with parallel layers, conditions, retries
- `src/workflow/dag.ts` — DAG utilities (toDAGExecutionLayers, evaluateCondition, validateDAG)
- `src/workflow/cf-workflow.ts` — CF Workflows POC (SkillWorkflow with durable step execution)
- `src/workflow/input-mapping.ts` — $prev/$step.N resolver
- `src/conversation/manager.ts` — multi-turn conversation state management (KV-backed)
- `src/db/schema.ts` — Drizzle schema (workflow_sessions, step_executions, execution_traces, tenant_policies, api_keys)
- `src/db/repository.ts` — DB operations (sessions, policies, traces, API keys)
- `src/routes/run.ts` — /v1/workflows/* (primary) + /v1/run/* (deprecated aliases), /v1/models
- `src/routes/sessions.ts` — /v1/sessions, /v1/sessions/:id, /v1/sessions/:id/trace, conversations CRUD
- `src/routes/skills.ts` — /v1/skills/composites CRUD (list, detail, update, deprecate, fork)
- `src/routes/chat.ts` — /v1/chat (Clove-compatible, AI SDK Data Stream Protocol)
- `src/routes/approvals.ts` — /v1/approvals/:id/approve|reject (alias to engine.resume)
- `src/routes/analytics.ts` — /v1/analytics/usage (tenant usage metrics)
- `src/routes/admin.ts` — /admin/api-keys, /admin/policies
- `src/routes/health.ts` — /health
- `scripts/smoke-test.ts` — E2E smoke test against live deployment
- `wrangler.toml` — staging config (phantoms account), all bindings with real IDs, cron trigger
- `wrangler.production.toml` — production config template (cognium account), needs provisioning
- `.dev.vars` — local secrets (LLMPROXY_API_KEY, DAYTONA_API_KEY, DATABASE_URL, ADMIN_SECRET)

## Spec
Master specification: `/Users/eyal/work/openmason/cortex.md` (source of truth)
Related specs in `/Users/eyal/work/openmason/`:
- `architecture.md` — Cognium Labs overall architecture
- `runics.md` — Skill registry specification
- `principles.md` — Cross-product design principles
- `skill-convention.md` — First-party skill authoring conventions
- `forge.md` — Skill distillation (decoupled from Cortex)

## DB Driver
- Uses `postgres` (postgres.js) with `drizzle-orm/postgres-js` — NOT `@neondatabase/serverless`
- The Neon HTTP driver (`neon()`) bypasses Hyperdrive; `postgres.js` is required for Hyperdrive connection pooling
- `{ prepare: false }` is required — Hyperdrive handles prepared statement caching
- `nodejs_compat` compatibility flag enabled in `wrangler.toml`

## Known Issues
- **KV free-tier daily write limit** — `WORKFLOW_STATE` KV still hits the daily write cap for workflow state writes and health checks. API keys are now in Neon DB (resolved). Health check uses read-only KV check to avoid burning writes. Rate limiter and auth backfill KV writes are non-blocking (`waitUntil` + `try/catch`).
- **Workers AI tool calling** — `gpt-oss-120b` supports tool calling via the `/v1/chat/completions` endpoint (proxy fix applied 2026-03-14). Requires: `content:null` → `""` sanitization, omit `tool_choice:"auto"`, tool param schemas use `type:"string"` (not objects). `qwen-2.5-coder` still no tool calling.

## Decoupling Status (Completed)
Cognium and Forge queue integrations have been removed. What remains:
- `src/clients/cognium.ts` — **Kept** as a stateless trust checker. `CogniumClient.checkTrust()` validates appetite thresholds and revocation status. No env dependency, no queue access.
- `src/clients/forge.ts` — **Kept** for `humanDistill()` only (user-initiated save-as-skill). `autoDistill()` and `generateSkill()` removed (Forge subscribes to events independently).
- Queue consumers (`forge-consumer.ts`, `cognium-consumer.ts`) — **Deleted**.
- `FORGE_QUEUE`, `COGNIUM_QUEUE`, `COGNIUM_URL` — **Removed** from `Env`, `wrangler.toml`, and all test mocks.

## Observability
- **Structured logging**: `src/observability/logger.ts` — JSON output via console.log/warn/error/debug, child loggers, level filtering (debug < info < warn < error)
- **Metrics**: `src/observability/metrics.ts` — Cloudflare Analytics Engine `writeDataPoint()`, fire-and-forget, no-op when binding missing
- **Analytics Engine dataset**: `cortex_metrics` (binding: `ANALYTICS`, enabled in `wrangler.toml`). Schema: index: tenantId, blobs: [event, requestId, product, skillSlug, status, error], doubles: [durationMs, tokens, cost]
- **Request ID**: `X-Request-ID` header propagated/generated on every request, threaded through Logger context
- **Constructor chain**: Logger + Metrics created per-request in route handlers, passed through Supervisor → Engine → Router → Repository via optional constructor params
- **Instrumentation points**: request (run handler), skill_exec (router), codegen (router), llm_call (LLMClient), api_usage (auth middleware), workflow (engine), cron (index.ts)
- **Per-API-key tracking**: `usageTrackingMiddleware` fires `api_usage` event after every `/v1/*` request with key prefix (first 8 chars), HTTP status, endpoint (on error), latency
- **Per-turn usage tracking**: `ConversationState.turnMetrics` records tokens, cost, and tool calls for each LLM turn. `GET /v1/sessions/conversations/:id` returns `turnMetrics` array + aggregate `usage: { totalTokens, totalCost }`
- **RunResponse usage**: `POST /v1/workflows` returns `usage: { totalTokens, totalCost }` from the agent loop

## Architecture Decisions — Spec vs Reality

Key differences between the master spec (`/Users/eyal/work/openmason/cortex.md`) and what's actually built. These are intentional — revisit as needed.

### Mastra — Not Used (Future Integration)
- `@mastra/core` (0.5.0) and `@mastra/cloudflare` (0.1.0) are in `package.json` but **zero imports** exist.
- Everything Mastra would provide is custom-built: `SupervisorAgent` (agentic loop), `WorkflowEngine` (pause/resume), `ConversationManager` (memory), `WorkflowDurableObject` (durable execution).
- Mastra's Cloudflare support was too immature at build time (v0.1.0). May revisit when it stabilizes.
- **If adopting Mastra later**: replace SupervisorAgent with Mastra `Agent`, WorkflowEngine with Mastra `Workflow`/`Step`, and use Mastra's native pause/resume instead of KV state management.

### LLM Proxy — Decided
- All LLM calls route through `https://llmproxy.xus.one` (LiteLLM → OpenRouter / Cloudflare Workers AI). This is final.
- The spec references direct Anthropic API calls (`Claude Sonnet`). Reality: all models are accessed through the proxy with a unified OpenAI-compatible interface.
- Model selection, fallback chains, and format normalization are handled at the proxy layer, not in Cortex.

### AI SDK Data Stream Protocol — Implemented
- Cortex uses the **AI SDK UI Message Stream v1** (AI SDK 5+) format for all streaming endpoints.
- Format: standard SSE `data: {json}\n\n` with `type` inside JSON. No `event:` field. Header: `x-vercel-ai-ui-message-stream: v1`. Stream ends with `: [DONE]`.
- Types: `text-start`, `text-delta`, `text-end`, `tool-call`, `tool-result`, `step-start`, `step-finish`, `data` (custom), `error`, `finish`.
- Custom data parts (via `{type:"data", data:[...]}`) carry `conversation`, `workflow-complete`, `approval-required`.

### API Shape Drift
- `POST /v1/workflows` — primary workflow endpoint (spec v2 aligned), accepts `product + prompt + appetite + mode`
- `POST /v1/run` — **DEPRECATED** alias for `/v1/workflows` (backward compatibility only)
- `POST /v1/chat` — Clove-compatible endpoint added (accepts `productId + messages` with parts array, streams AI SDK v5+ SSE)
- `POST /v1/approvals/:id/approve` and `/reject` — alias routes added, delegate to `engine.resume()`
- Spec says per-product `approvalTimeoutMs` — reality uses global `WORKFLOW_TIMEOUT_MS`

### Activepieces — Not Started
- Spec lists Activepieces as the event/trigger layer (webhooks, cron, email, Stripe, GitHub PRs).
- Not integrated. Would be a separate self-hosted service ($10/mo VPS).

## Current State (2026-05-02)

### Deployed to Staging
- **URL**: `https://cortex.phantoms.workers.dev`
- **Account**: phantoms (1f59f4dcd0ebb559e3c392566978d446)
- **Tests**: 558 passing across 32 test files
- **Smoke tests**: 8 passed, 1 warn (Runics unavailable)

### Recently Completed
- **CF Workflows POC** — `SkillWorkflow` with durable `step.do()` execution, automatic retries, checkpointing
- **DAG Workflow Engine** — Parallel layer execution with Kahn's algorithm, $context support, callbackUrl webhooks
- **Production hardening** — CORS lockdown, per-API-key rate limiting, production config template

### Architecture Summary
```
┌─────────────────────────────────────────────────────────────────┐
│                         Cortex Runtime                          │
├─────────────────────────────────────────────────────────────────┤
│  Routes: /v1/workflows, /v1/chat, /v1/sessions, /v1/skills     │
│  ├─ SupervisorAgent (LLM agentic loop with tool calling)       │
│  ├─ WorkflowEngine (sequential, pause/resume, DB persistence)  │
│  ├─ DAGWorkflowEngine (parallel layers, conditions, retries)   │
│  └─ CF SkillWorkflow (durable execution POC)                   │
├─────────────────────────────────────────────────────────────────┤
│  Execution Router (5 layers)                                    │
│  ├─ L0: mcp-remote (HTTP to external MCP)                      │
│  ├─ L1: instructions (SKILL.md for LLM)                        │
│  ├─ L2: worker (Cloudflare Workers)                            │
│  ├─ L3: container (Daytona sandbox)                            │
│  └─ Codegen fallback (LLM generates code → Daytona)            │
├─────────────────────────────────────────────────────────────────┤
│  External Services                                              │
│  ├─ Runics (skill registry, trust scores)                      │
│  ├─ Daytona (sandboxed code execution)                         │
│  ├─ LLM Proxy (llmproxy.xus.one → OpenRouter/Workers AI)       │
│  └─ Neon Postgres (via Hyperdrive)                             │
└─────────────────────────────────────────────────────────────────┘
```

### Bindings Active
- `WORKFLOW_DO` — Durable Object for workflow state
- `SKILL_WORKFLOW` — CF Workflow for durable skill execution
- `SESSION_CACHE` / `WORKFLOW_STATE` — KV namespaces
- `HYPERDRIVE` — Neon Postgres connection pooling
- `R2_BUCKET` — Artifact storage
- `ANALYTICS` — Analytics Engine metrics
- `RUNICS_SERVICE` — Service binding to Runics worker

## Next Steps (Prioritized)
1. **Provision production** — Run `wrangler.production.toml` checklist for cognium account (`cortex.cognium.net`)
2. **Register Runics skills** — Add `@runics/git-clone`, `@runics/secrets-scan`, `@runics/github-pr`
3. **DAGWorkflow** — Extend CF Workflows to wrap DAGWorkflowEngine for full durable DAG execution
4. **Token-level streaming** — Stream LLM tokens to client as they arrive (not just tool events)
5. **Activepieces integration** — Triggers & events (webhooks, cron, email, Stripe, GitHub PRs)

## Deferred / Revisit

### Mastra Integration (Revisit: June 2026)
`@mastra/core` (0.5.0) and `@mastra/cloudflare` (0.1.4) are in `package.json` but unused. Analysis (May 2026):

**Why not used:**
- `@mastra/cloudflare` is only a KV storage adapter, not CF Workers deployment
- No CF Workflows, Durable Objects, or Hyperdrive integration
- Cortex has custom implementations: SupervisorAgent (710 LOC), WorkflowEngine (469 LOC), DAGWorkflowEngine (867 LOC), ConversationManager (205 LOC) — all tested (558 tests)
- Tight coupling to Cortex-specific execution model (5 layers, codegen fallback, Runics/Daytona integration)

**Revisit when:**
- Mastra adds native CF Workflows integration
- Mastra adds Durable Objects support
- Major refactor is needed anyway

**Decision:** Keep deps, revisit June 2026 after Mastra v1.x matures
