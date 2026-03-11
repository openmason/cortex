import { Hono } from "hono";
import { z } from "zod";
import type { Env, ApiKeyData } from "../types";
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

// ---------------------------------------------------------------------------
// POST /admin/api-keys — Create an API key
// ---------------------------------------------------------------------------
const VALID_SCOPES = ["run", "sessions", "skills", "models"] as const;

const createKeySchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  product: z.enum(["bombastic", "costaff", "controlcenter"]),
  scopes: z.array(z.enum(VALID_SCOPES)).default(["run", "sessions"]),
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

  return c.json({ key, ...data }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /admin/api-keys/:key — Revoke an API key
// ---------------------------------------------------------------------------
app.delete("/api-keys/:key", async (c) => {
  const key = c.req.param("key");

  // Revoke in DB (source of truth)
  const repo = new WorkflowRepository(c.env);
  await repo.revokeApiKey(key);

  // Invalidate KV cache (best-effort)
  try {
    await c.env.SESSION_CACHE.delete(`apikey:${key}`);
  } catch {
    // Non-critical — TTL will expire the cache entry
  }

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
  await repo.upsertPolicy(policy);

  // Invalidate KV cache
  const cacheKey = `policy:${policy.tenantId}:${policy.product}`;
  try {
    await c.env.SESSION_CACHE.delete(cacheKey);
  } catch {
    // Non-critical
  }

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

export default app;
