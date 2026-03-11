# Cortex — Shared Agent Runtime

## Project Overview
Cloudflare Workers-based agent runtime that orchestrates skill discovery, planning, and execution. Built with Hono, Drizzle ORM, Neon Postgres via Hyperdrive.

## Architecture
- **Supervisor Agent** (`src/agents/supervisor.ts`) — LLM-powered agentic loop with tool calling (findSkill, checkPolicy, buildPlan, invokeSkill)
- **Workflow Engine** (`src/workflow/engine.ts`) — orchestrates multi-step skill execution with pause/resume, input mapping ($prev, $step.N)
- **Execution Router** (`src/execution/router.ts`) — dispatches to 5 layers: mcp-remote, instructions, worker, container, composite
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
- Default model: `cognium/claude-sonnet-latest`
- **OpenRouter compat**: Handled at the proxy layer (v0.5.2) — response normalization + input message normalization. All models work for multi-turn tool calling.
- Models constant in `src/clients/llm.ts` MODELS object

## Infrastructure (Provisioned)
- **Neon DB**: Connection string in `.dev.vars` / wrangler secret `DATABASE_URL`
- **Hyperdrive**: ID in `wrangler.toml`
- **KV SESSION_CACHE**: ID in `wrangler.toml`
- **KV WORKFLOW_STATE**: ID in `wrangler.toml`
- **R2 Bucket**: `cortex-artifacts`
- **Queues**: `cortex-events` — workflow lifecycle events (completion, save-as-skill). Consumed by Forge independently.
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
  - `run` — `/v1/run`, `/v1/run/stream`, `/v1/run/:id`, `/v1/run/:id/resume`, `/v1/run/:id/save`
  - `sessions` — `/v1/sessions/*`
  - `skills` — `/v1/skills/*`
  - `models` — no scope required (open to any authenticated key)
- Valid scopes: `["run", "sessions", "skills", "models"]`
- Default scopes on new keys: `["run", "sessions"]`
- **Visibility enforcement**: `userId` is passed to Runics in `findSkill` and `listComposites` for private skill filtering

## API Endpoints
- `GET /` — Service info
- `GET /health` — Health check (KV + DB/Hyperdrive + Runics)
- `POST /v1/run` — Start workflow (JSON response)
- `POST /v1/run/stream` — Start workflow (SSE streaming)
- `GET /v1/run/:id` — Workflow status
- `POST /v1/run/:id/resume` — Resume paused workflow
- `POST /v1/run/:id/save` — Save workflow as skill
- `GET /v1/models` — List available LLM models
- `GET /v1/sessions` — List sessions (tenant-scoped, paginated)
- `GET /v1/sessions/:id` — Session detail with step executions
- `GET /v1/sessions/:id/trace` — Execution trace (consumed by Forge independently)
- `GET /v1/skills/composites` — List composite skills (tenant-scoped, paginated)
- `GET /v1/skills/composites/:slug` — Composite detail with composition steps
- `PATCH /v1/skills/composites/:slug` — Update composite metadata
- `POST /v1/skills/composites/:slug/deprecate` — Deprecate a composite
- `POST /v1/skills/composites/:slug/fork` — Fork a composite
- `POST /admin/api-keys` — Create API key
- `DELETE /admin/api-keys/:key` — Revoke API key
- `PUT /admin/policies` — Upsert tenant policy
- `GET /admin/policies/:tenantId/:product` — Get tenant policy

## SSE Streaming
- `POST /v1/run/stream` returns Server-Sent Events
- Event types: `planning`, `tool_call`, `tool_result`, `step_start`, `step_complete`, `workflow_complete`, `error`, `done`
- Non-streaming `/v1/run` unchanged

## Tenant Policies
- Policy loading chain: KV cache (5 min TTL) → DB (`tenant_policies` table) → `defaultPolicy()` fallback
- Zero behavior change until a `tenant_policies` row is inserted
- Admin endpoints: `PUT /admin/policies`, `GET /admin/policies/:tenantId/:product`

## Workflow State Fallback
- `GET /v1/run/:id` uses `engine.loadState()`: KV cache → DB fallback (reconstructs `WorkflowState` from `workflow_sessions` row)
- `saveAsSkill` also uses `engine.loadState()` for the same fallback

## Workflow Timeout Enforcement
- Paused workflows (`paused_for_review`, `paused_at_step`) get `timeoutAt` set to `now + WORKFLOW_TIMEOUT_MS` (default 5 min)
- **Lazy check**: `GET /v1/run/:id` checks `timeoutAt` and transitions to `timed_out` if expired
- **Resume guard**: `engine.resume()` checks timeout before allowing execution
- **Cron sweep**: `*/5 * * * *` cron lists `workflow:*` KV keys, expires any paused workflows past `timeoutAt`
- Backward compat: old states without `timeoutAt` are never lazily timed out

## Testing
- 380 unit tests passing across 24 test files (`npx vitest run`)
- Local dev tested with `npx wrangler dev` — health, models, and full run request all work
- E2E smoke test: `ADMIN_SECRET=<secret> npx tsx scripts/smoke-test.ts` (9 tests against live deployment)
- Sample query script: `scripts/sample-query.ts` (mocked, in-process)

## Key Files
- `src/index.ts` — Hono app, queue handler, cron handler
- `src/types.ts` — all shared types, Env, AppVariables, SSEEvent
- `src/middleware/auth.ts` — Bearer API key auth middleware
- `src/agents/supervisor.ts` — main request handler with LLM agentic loop + streaming variant
- `src/agents/tools.ts` — tool definitions and ToolExecutor
- `src/clients/llm.ts` — LLM proxy client (chat, agentLoop with onEvent, listModels)
- `src/workflow/engine.ts` — workflow orchestration with DB persistence and SSE events
- `src/workflow/input-mapping.ts` — $prev/$step.N resolver
- `src/db/schema.ts` — Drizzle schema (workflow_sessions, step_executions, execution_traces, tenant_policies, api_keys)
- `src/db/repository.ts` — DB operations (sessions, policies, traces, API keys)
- `src/routes/run.ts` — /v1/run, /v1/run/stream, /v1/run/:id, resume, save, models
- `src/routes/sessions.ts` — /v1/sessions, /v1/sessions/:id, /v1/sessions/:id/trace
- `src/routes/skills.ts` — /v1/skills/composites CRUD (list, detail, update, deprecate, fork)
- `src/routes/admin.ts` — /admin/api-keys, /admin/policies
- `src/routes/health.ts` — /health
- `scripts/smoke-test.ts` — E2E smoke test against live deployment
- `wrangler.toml` — all bindings with real IDs, cron trigger
- `.dev.vars` — local secrets (LLMPROXY_API_KEY, DAYTONA_API_KEY, DATABASE_URL, ADMIN_SECRET)

## Spec
Master specification: `cortex-specification.md`

## DB Driver
- Uses `postgres` (postgres.js) with `drizzle-orm/postgres-js` — NOT `@neondatabase/serverless`
- The Neon HTTP driver (`neon()`) bypasses Hyperdrive; `postgres.js` is required for Hyperdrive connection pooling
- `{ prepare: false }` is required — Hyperdrive handles prepared statement caching
- `nodejs_compat` compatibility flag enabled in `wrangler.toml`

## Known Issues
- **KV free-tier daily write limit** — `WORKFLOW_STATE` KV still hits the daily write cap for workflow state writes and health checks. API keys are now in Neon DB (resolved). Health check uses read-only KV check to avoid burning writes.

## Code Cleanup Needed
The following files still contain direct Cognium/Forge integration that should be decoupled:
- `src/clients/cognium.ts` — **Remove**. Trust scores come from Runics; Cognium is Runics' concern.
- `src/clients/forge.ts` — **Remove**. Forge is independent; Cortex emits events, not direct calls.
- `src/queues/cognium-consumer.ts` — **Remove**. Scanning is Runics→Cognium, not Cortex.
- `src/queues/forge-consumer.ts` — **Remove**. Forge has its own consumer.
- `src/agents/tools.ts` — Remove `CogniumClient` import and `cognium.checkTrust()` calls. Trust scores are already on skills from Runics; PolicyEngine handles threshold checks.
- `src/workflow/engine.ts` — Remove `CogniumClient` and `ForgeClient` imports. Replace `forge.autoDistill()` with a generic event emit (queue message or webhook).
- `src/agents/supervisor.ts` — Remove `ForgeClient` import. `save-as-skill` should emit an event, not call Forge directly.
- `src/index.ts` — Remove `handleForgeMessage` and `handleCogniumMessage` imports and queue routing.
- `src/types.ts` — Remove `FORGE_QUEUE`, `COGNIUM_QUEUE`, `COGNIUM_URL` from `Env`.
- `wrangler.toml` — Replace `cortex-forge` and `cortex-cognium` queue bindings with a single `cortex-events` queue.

## Next Steps (Prioritized)
1. **Decouple Cognium and Forge** — remove direct integrations per the cleanup list above. Replace with event emission.
2. Rate limiting / usage tracking per API key
3. Observability — structured logging, Cloudflare Analytics Engine
4. Webhook/callback support for long-running workflows
