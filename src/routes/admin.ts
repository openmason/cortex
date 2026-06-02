import { Hono } from "hono";
import { z } from "zod";
import type { Env, ApiKeyData, AuditEntry, AuditQueryFilters } from "../types";
import { PolicyEngine, defaultPolicy } from "../policy/engine";
import { WorkflowRepository } from "../db/repository";

const app = new Hono<{ Bindings: Env }>();

/**
 * Admin auth: all /admin routes require Authorization: Bearer <ADMIN_SECRET>.
 */
app.use("*", async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || header !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

/**
 * Helper to write an audit entry.
 * Non-blocking — errors are logged but don't fail the request.
 */
async function writeAudit(
  env: Env,
  entry: Omit<AuditEntry, "requestId" | "ipAddress" | "userAgent">,
  req: Request,
): Promise<void> {
  const repo = new WorkflowRepository(env);
  await repo.writeAuditEntry({
    ...entry,
    requestId: req.headers.get("X-Request-ID") ?? undefined,
    ipAddress: req.headers.get("CF-Connecting-IP") ?? undefined,
    userAgent: req.headers.get("User-Agent") ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// POST /admin/api-keys — Create an API key
// ---------------------------------------------------------------------------
// "workflows" is the primary scope (spec v2); "run" kept for backward compatibility
const VALID_SCOPES = ["workflows", "run", "sessions", "skills", "models"] as const;
const VALID_SOURCES = ["chat", "job", "webhook", "api"] as const;

const createKeySchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  product: z.enum(["bombastic", "costaff", "controlcenter"]),
  scopes: z.array(z.enum(VALID_SCOPES)).default(["workflows", "sessions"]),
  source: z.enum(VALID_SOURCES).default("api"),
});

app.post("/api-keys", async (c) => {
  const body = await c.req.json();
  const parsed = createKeySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const key = `ctx_${crypto.randomUUID().replaceAll("-", "")}`;
  const data: ApiKeyData = {
    ...parsed.data,
    createdAt: new Date().toISOString(),
  };

  // Write to DB (source of truth)
  const repo = new WorkflowRepository(c.env);
  await repo.createApiKey(key, data);

  // Write-through to KV cache (best-effort)
  try {
    await c.env.SESSION_CACHE.put(
      `apikey:${key}`,
      JSON.stringify(data),
      { expirationTtl: 300 },
    );
  } catch {
    // Non-critical — auth middleware will backfill from DB on miss
  }

  // Audit log
  await writeAudit(c.env, {
    tenantId: data.tenantId,
    userId: data.userId,
    action: "api_key.create",
    resourceType: "api_key",
    resourceId: key.slice(0, 12), // Log prefix only for security
    metadata: { product: data.product, scopes: data.scopes, source: data.source },
    status: "success",
  }, c.req.raw);

  return c.json({ key, ...data }, 201);
});

// ---------------------------------------------------------------------------
// GET /admin/api-keys — List API keys for a tenant
// ---------------------------------------------------------------------------
app.get("/api-keys", async (c) => {
  const tenantId = c.req.query("tenantId");
  if (!tenantId) {
    return c.json({ error: "tenantId query parameter required" }, 400);
  }

  // For now, return a message that listing isn't fully implemented
  // (would need to add a listApiKeys method to repository)
  return c.json({
    message: "API key listing not yet implemented. Use database directly for now.",
    tenantId,
  });
});

// ---------------------------------------------------------------------------
// DELETE /admin/api-keys/:key — Revoke an API key
// ---------------------------------------------------------------------------
app.delete("/api-keys/:key", async (c) => {
  const key = c.req.param("key");
  const tenantId = c.req.query("tenantId") ?? "unknown";

  // Revoke in DB (source of truth)
  const repo = new WorkflowRepository(c.env);
  await repo.revokeApiKey(key);

  // Invalidate KV cache (best-effort)
  try {
    await c.env.SESSION_CACHE.delete(`apikey:${key}`);
  } catch {
    // Non-critical — TTL will expire the cache entry
  }

  // Audit log
  await writeAudit(c.env, {
    tenantId,
    action: "api_key.revoke",
    resourceType: "api_key",
    resourceId: key.slice(0, 12),
    status: "success",
  }, c.req.raw);

  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// PUT /admin/policies — Upsert a tenant policy
// ---------------------------------------------------------------------------
const policySchema = z.object({
  tenantId: z.string().min(1),
  product: z.enum(["bombastic", "costaff", "controlcenter"]),
  defaultMode: z.enum(["full_auto", "review_before_run", "step_by_step"]).optional(),
  defaultAppetite: z.enum(["strict", "cautious", "balanced", "adventurous"]).optional(),
  trustFloor: z.number().min(0).max(1).optional(),
  enableHumanReview: z.boolean().optional(),
  sensitiveCategories: z.array(z.string()).optional(),
  blockedSkillSlugs: z.array(z.string()).optional(),
  maxConcurrentWorkflows: z.number().int().min(1).max(100).optional(),
});

app.put("/policies", async (c) => {
  const body = await c.req.json();
  const parsed = policySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  // Merge with defaults so unset fields get product defaults
  const base = defaultPolicy(parsed.data.tenantId, parsed.data.product);
  const policy = {
    ...base,
    ...Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ),
  };

  const repo = new WorkflowRepository(c.env);

  // Check if policy exists to determine action
  const existing = await repo.loadPolicy(policy.tenantId, policy.product);
  const action = existing ? "policy.update" : "policy.create";

  await repo.upsertPolicy(policy);

  // Invalidate KV cache
  const cacheKey = `policy:${policy.tenantId}:${policy.product}`;
  try {
    await c.env.SESSION_CACHE.delete(cacheKey);
  } catch {
    // Non-critical
  }

  // Audit log
  await writeAudit(c.env, {
    tenantId: policy.tenantId,
    action,
    resourceType: "policy",
    resourceId: `${policy.tenantId}:${policy.product}`,
    metadata: { product: policy.product, changes: parsed.data },
    status: "success",
  }, c.req.raw);

  return c.json(policy);
});

// ---------------------------------------------------------------------------
// GET /admin/policies/:tenantId/:product — Get a tenant policy
// ---------------------------------------------------------------------------
app.get("/policies/:tenantId/:product", async (c) => {
  const tenantId = c.req.param("tenantId");
  const product = c.req.param("product");

  const policyEngine = new PolicyEngine(c.env);
  const policy = await policyEngine.loadPolicy(tenantId, product);

  return c.json(policy);
});

// ---------------------------------------------------------------------------
// GET /admin/audit — Query audit log
// ---------------------------------------------------------------------------
const auditQuerySchema = z.object({
  tenantId: z.string().min(1),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  userId: z.string().optional(),
  status: z.enum(["success", "failure", "denied"]).optional(),
  from: z.string().optional(), // ISO date string
  to: z.string().optional(), // ISO date string
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get("/audit", async (c) => {
  const query = c.req.query();
  const parsed = auditQuerySchema.safeParse(query);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const { tenantId, limit, offset, ...filters } = parsed.data;

  const repo = new WorkflowRepository(c.env);

  const [entries, total] = await Promise.all([
    repo.queryAuditLog(tenantId, filters as AuditQueryFilters, limit, offset),
    repo.countAuditEntries(tenantId, filters as AuditQueryFilters),
  ]);

  return c.json({
    entries,
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// CF Workflows Admin Routes (POC)
// ---------------------------------------------------------------------------

/**
 * POST /admin/workflows/skill — Trigger a SkillWorkflow instance
 */
const triggerWorkflowSchema = z.object({
  skillSlug: z.string().min(1),
  skillVersion: z.string().optional(),
  input: z.record(z.unknown()).default({}),
  tenantId: z.string().min(1),
});

app.post("/workflows/skill", async (c) => {
  if (!c.env.SKILL_WORKFLOW) {
    return c.json({ error: "CF Workflows not enabled in this environment" }, 501);
  }

  const body = await c.req.json();
  const parsed = triggerWorkflowSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const requestId = c.req.header("X-Request-ID") ?? crypto.randomUUID();
  const params = { ...parsed.data, requestId };

  // Create a new workflow instance
  const instance = await c.env.SKILL_WORKFLOW.create({ params });

  return c.json({
    instanceId: instance.id,
    status: "queued",
    params,
  }, 202);
});

/**
 * GET /admin/workflows/skill/:instanceId — Get SkillWorkflow instance status
 */
app.get("/workflows/skill/:instanceId", async (c) => {
  if (!c.env.SKILL_WORKFLOW) {
    return c.json({ error: "CF Workflows not enabled in this environment" }, 501);
  }

  const instanceId = c.req.param("instanceId");

  try {
    const instance = await c.env.SKILL_WORKFLOW.get(instanceId);
    const status = await instance.status();

    return c.json({
      instanceId,
      status: status.status,
      output: status.output,
      error: status.error,
    });
  } catch (err) {
    return c.json({
      error: "Workflow instance not found",
      instanceId,
    }, 404);
  }
});

export default app;
