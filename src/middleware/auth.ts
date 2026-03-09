import { createMiddleware } from "hono/factory";
import type { Env, AppVariables, ApiKeyData } from "../types";

/**
 * Bearer API key auth middleware for /v1/* routes.
 *
 * Looks up the key in SESSION_CACHE KV (`apikey:{key}` → ApiKeyData JSON).
 * On success, injects tenantId/userId/product/scopes into Hono context.
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

  const raw = await c.env.SESSION_CACHE.get(`apikey:${key}`);
  if (!raw) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  let data: ApiKeyData;
  try {
    data = JSON.parse(raw);
  } catch {
    return c.json({ error: "Corrupted API key data" }, 500);
  }

  c.set("tenantId", data.tenantId);
  c.set("userId", data.userId);
  c.set("product", data.product);
  c.set("scopes", data.scopes);

  await next();
});
