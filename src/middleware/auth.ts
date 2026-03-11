import { createMiddleware } from "hono/factory";
import type { Env, AppVariables, ApiKeyData } from "../types";
import { WorkflowRepository } from "../db/repository";

const API_KEY_CACHE_TTL = 300; // 5 minutes

/**
 * Bearer API key auth middleware for /v1/* routes.
 *
 * Fast path: KV cache (`apikey:{key}` → ApiKeyData JSON).
 * Fallback: DB lookup via WorkflowRepository, backfills KV on hit.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice(7);
  if (!key) {
    return c.json({ error: "Missing API key" }, 401);
  }

  // 1. Try KV cache first (fast path)
  let data: ApiKeyData | undefined;
  const raw = await c.env.SESSION_CACHE.get(`apikey:${key}`);
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      // Corrupted cache entry — fall through to DB
    }
  }

  // 2. KV miss or corrupted — try DB
  if (!data) {
    try {
      const repo = new WorkflowRepository(c.env);
      const dbData = await repo.getApiKey(key);
      if (!dbData) {
        return c.json({ error: "Invalid API key" }, 401);
      }
      data = dbData;

      // 3. Backfill KV cache (best-effort, non-blocking)
      c.executionCtx.waitUntil(
        c.env.SESSION_CACHE.put(
          `apikey:${key}`,
          JSON.stringify(data),
          { expirationTtl: API_KEY_CACHE_TTL },
        ).catch(() => {}),
      );
    } catch {
      return c.json({ error: "Invalid API key" }, 401);
    }
  }

  c.set("tenantId", data.tenantId);
  c.set("userId", data.userId);
  c.set("product", data.product);
  c.set("scopes", data.scopes);

  await next();
});

/**
 * Scope enforcement middleware factory.
 * Returns 403 if the authenticated API key doesn't have the required scope.
 */
export function requireScope(scope: string) {
  return createMiddleware<{
    Bindings: Env;
    Variables: AppVariables;
  }>(async (c, next) => {
    const scopes = c.get("scopes") ?? [];
    if (!scopes.includes(scope)) {
      return c.json({ error: `Missing required scope: ${scope}` }, 403);
    }
    await next();
  });
}

const RATE_LIMIT_WINDOW = 60;     // 1 minute window
const RATE_LIMIT_MAX = 30;        // 30 requests per window

/**
 * Simple KV-based rate limiter per tenant.
 * Uses a sliding window counter stored in SESSION_CACHE.
 */
export const rateLimitMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const tenantId = c.get("tenantId");
  if (!tenantId) {
    await next();
    return;
  }

  try {
    const windowKey = `ratelimit:${tenantId}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;

    const current = parseInt(await c.env.SESSION_CACHE.get(windowKey) ?? "0", 10);
    if (current >= RATE_LIMIT_MAX) {
      return c.json(
        { error: "Rate limit exceeded. Try again shortly." },
        429,
      );
    }

    // Increment (best-effort — KV is eventually consistent but fine for rate limiting)
    c.executionCtx.waitUntil(
      c.env.SESSION_CACHE.put(windowKey, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW * 2 }).catch(() => {}),
    );

    c.header("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    c.header("X-RateLimit-Remaining", String(RATE_LIMIT_MAX - current - 1));
  } catch {
    // Rate limiting is best-effort — don't block requests if KV fails
  }

  await next();
});
