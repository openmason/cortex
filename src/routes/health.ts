import { Hono } from "hono";
import postgres from "postgres";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // KV check (read-only to avoid burning free-tier writes)
  const kvStart = Date.now();
  try {
    await c.env.WORKFLOW_STATE.get("health:ping");
    checks.kv = { ok: true, latencyMs: Date.now() - kvStart };
  } catch (err) {
    checks.kv = { ok: false, latencyMs: Date.now() - kvStart, error: String(err) };
  }

  // DB check via Hyperdrive
  const dbStart = Date.now();
  try {
    const sql = postgres(c.env.HYPERDRIVE.connectionString, { prepare: false });
    await sql`SELECT 1`;
    await sql.end();
    checks.db = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.db = { ok: false, latencyMs: Date.now() - dbStart, error: String(err) };
  }

  // Runics check (use service binding if available to avoid error 1042)
  const runicsStart = Date.now();
  try {
    const res = c.env.RUNICS_SERVICE
      ? await c.env.RUNICS_SERVICE.fetch(new Request("https://runics.internal/health"))
      : await fetch(`${c.env.RUNICS_URL}/health`);
    checks.runics = { ok: res.ok, latencyMs: Date.now() - runicsStart };
  } catch (err) {
    checks.runics = { ok: false, latencyMs: Date.now() - runicsStart, error: String(err) };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return c.json(
    {
      status: allOk ? "healthy" : "degraded",
      version: "0.1.0",
      checks,
      timestamp: new Date().toISOString(),
    },
    allOk ? 200 : 503,
  );
});

export default app;
