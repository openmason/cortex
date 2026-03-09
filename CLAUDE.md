# Cortex — Shared Agent Runtime

## Project Overview
Cloudflare Workers-based agent runtime that orchestrates skill discovery, planning, and execution. Built with Hono, Drizzle ORM, Neon Postgres via Hyperdrive.

## Architecture
- **Supervisor Agent** (`src/agents/supervisor.ts`) — LLM-powered agentic loop with tool calling (findSkill, checkPolicy, buildPlan, invokeSkill)
- **Workflow Engine** (`src/workflow/engine.ts`) — orchestrates multi-step skill execution with pause/resume, input mapping ($prev, $step.N)
- **Execution Router** (`src/execution/router.ts`) — dispatches to 5 layers: mcp-remote, instructions, worker, container, composite
- **Policy Engine** (`src/policy/engine.ts`) — tenant-level trust checks, appetite thresholds, sensitive categories
- **Queue Consumers** — Forge (auto-distill, generate) and Cognium (scan, trust update)
- **DB Repository** (`src/db/repository.ts`) — Drizzle/Neon/Hyperdrive for durable workflow records

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
- **Queues**: `cortex-forge` and `cortex-cognium`
- **Service Binding**: `RUNICS_SERVICE` → `runics` worker

## Deploy Status
- **Live at**: `https://cortex.phantoms.workers.dev`
- Secrets set: LLMPROXY_API_KEY, DAYTONA_API_KEY (placeholder), DATABASE_URL, ADMIN_SECRET
- Schema already pushed to Neon DB (4 tables, 8 indexes)
- Durable Objects use `new_sqlite_classes` migration (required for free plan)

## Auth
- Bearer API key auth on all `/v1/*` routes via `src/middleware/auth.ts`
- Keys stored in `SESSION_CACHE` KV: `apikey:{key}` → `{tenantId, userId, product, scopes}`
- Key format: `ctx_` + 32 hex chars
- Admin routes (`/admin/*`) protected by `ADMIN_SECRET` env var
- Create keys: `POST /admin/api-keys` with `{tenantId, userId, product}`
- Revoke keys: `DELETE /admin/api-keys/:key`

## API Endpoints
- `GET /` — Service info
- `GET /health` — Health check (KV + Runics)
- `POST /v1/run` — Start workflow (JSON response)
- `POST /v1/run/stream` — Start workflow (SSE streaming)
- `GET /v1/run/:id` — Workflow status
- `POST /v1/run/:id/resume` — Resume paused workflow
- `POST /v1/run/:id/save` — Save workflow as skill
- `GET /v1/models` — List available LLM models
- `GET /v1/sessions` — List sessions (tenant-scoped, paginated)
- `GET /v1/sessions/:id` — Session detail with step executions
- `GET /v1/sessions/:id/trace` — Execution trace for Forge
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

## Testing
- 181 unit tests passing (`npx vitest run`)
- Local dev tested with `npx wrangler dev` — health, models, and full run request all work
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
- `src/db/schema.ts` — Drizzle schema (workflow_sessions, step_executions, execution_traces, tenant_policies)
- `src/db/repository.ts` — DB operations (sessions, policies, traces)
- `src/routes/run.ts` — /v1/run, /v1/run/stream, /v1/run/:id, resume, save, models
- `src/routes/sessions.ts` — /v1/sessions, /v1/sessions/:id, /v1/sessions/:id/trace
- `src/routes/admin.ts` — /admin/api-keys, /admin/policies
- `src/routes/health.ts` — /health
- `src/queues/forge-consumer.ts` — auto-distill and generate handlers
- `src/queues/cognium-consumer.ts` — scan and trust update handlers
- `wrangler.toml` — all bindings with real IDs
- `.dev.vars` — local secrets (LLMPROXY_API_KEY, DAYTONA_API_KEY, DATABASE_URL, ADMIN_SECRET)

## Spec
Master specification: `cortex-specification.md`

## Next Steps (Prioritized)
1. End-to-end workflow test with real LLM + Runics
2. Rate limiting / usage tracking
3. WebSocket support for real-time workflow updates
4. Multi-tenant isolation improvements
