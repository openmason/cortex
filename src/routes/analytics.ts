import { Hono } from "hono";
import type { Env } from "../types";
import { AnalyticsClient, type AnalyticsResult } from "../clients/analytics";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Admin auth (same pattern as /admin routes)
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header || header !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClient(env: Env): AnalyticsClient {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new ConfigError("Analytics not configured: CF_ACCOUNT_ID and CF_API_TOKEN required");
  }
  return new AnalyticsClient(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseHours(raw: string | undefined): number {
  if (!raw) return 24;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1 || n > 168) return 24;
  return n;
}

function numVal(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  return typeof v === "number" ? v : Number(v) || 0;
}

function strVal(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : String(v ?? "");
}

// ---------------------------------------------------------------------------
// GET /overview — High-level event breakdown
// ---------------------------------------------------------------------------
app.get("/overview", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        blob1 AS event,
        SUM(_sample_interval) AS total,
        SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg_duration_ms,
        SUM(double2 * _sample_interval) AS total_tokens,
        SUM(double3 * _sample_interval) AS total_cost_usd
      FROM cortex_metrics
      WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY blob1
      ORDER BY total DESC
    `);

    return c.json({
      period: `${hours}h`,
      events: result.data.map((r) => ({
        event: strVal(r, "event"),
        count: numVal(r, "total"),
        avgDurationMs: Math.round(numVal(r, "avg_duration_ms")),
        totalTokens: Math.round(numVal(r, "total_tokens")),
        totalCostUsd: Math.round(numVal(r, "total_cost_usd") * 10000) / 10000,
      })),
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /requests — Request volume timeseries
// ---------------------------------------------------------------------------
app.get("/requests", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
        SUM(_sample_interval) AS total,
        SUM(IF(blob5 = 'error', 1, 0) * _sample_interval) AS errors,
        SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg_duration_ms
      FROM cortex_metrics
      WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY hour
      ORDER BY hour
    `);

    return c.json({
      period: `${hours}h`,
      timeseries: result.data.map((r) => {
        const total = numVal(r, "total");
        const errors = numVal(r, "errors");
        return {
          hour: strVal(r, "hour"),
          total: Math.round(total),
          errors: Math.round(errors),
          errorRate: total > 0 ? Math.round((errors / total) * 10000) / 100 : 0,
          avgDurationMs: Math.round(numVal(r, "avg_duration_ms")),
        };
      }),
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /skills — Top skills by execution count
// ---------------------------------------------------------------------------
app.get("/skills", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        blob4 AS skill,
        SUM(_sample_interval) AS executions,
        SUM(IF(blob5 = 'ok', 1, 0) * _sample_interval) AS successes,
        SUM(IF(blob5 = 'error', 1, 0) * _sample_interval) AS failures,
        SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg_duration_ms
      FROM cortex_metrics
      WHERE blob1 = 'skill_exec' AND blob4 != '' AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY blob4
      ORDER BY executions DESC
      LIMIT 20
    `);

    return c.json({
      period: `${hours}h`,
      skills: result.data.map((r) => {
        const execs = numVal(r, "executions");
        const successes = numVal(r, "successes");
        return {
          slug: strVal(r, "skill"),
          executions: Math.round(execs),
          successes: Math.round(successes),
          failures: Math.round(numVal(r, "failures")),
          successRate: execs > 0 ? Math.round((successes / execs) * 10000) / 100 : 0,
          avgDurationMs: Math.round(numVal(r, "avg_duration_ms")),
        };
      }),
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /llm — LLM usage and cost
// ---------------------------------------------------------------------------
app.get("/llm", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        blob5 AS status,
        SUM(_sample_interval) AS calls,
        SUM(double2 * _sample_interval) AS total_tokens,
        SUM(double3 * _sample_interval) AS total_cost_usd,
        SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg_latency_ms
      FROM cortex_metrics
      WHERE blob1 = 'llm_call' AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY blob5
    `);

    let totalCalls = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalLatency = 0;
    let errorCalls = 0;

    for (const r of result.data) {
      const calls = numVal(r, "calls");
      totalCalls += calls;
      totalTokens += numVal(r, "total_tokens");
      totalCostUsd += numVal(r, "total_cost_usd");
      totalLatency += numVal(r, "avg_latency_ms") * calls;
      if (strVal(r, "status") === "error") errorCalls += calls;
    }

    return c.json({
      period: `${hours}h`,
      llm: {
        totalCalls: Math.round(totalCalls),
        totalTokens: Math.round(totalTokens),
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
        avgLatencyMs: totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0,
        errorRate: totalCalls > 0 ? Math.round((errorCalls / totalCalls) * 10000) / 100 : 0,
        breakdown: result.data.map((r) => ({
          status: strVal(r, "status"),
          calls: Math.round(numVal(r, "calls")),
          tokens: Math.round(numVal(r, "total_tokens")),
          costUsd: Math.round(numVal(r, "total_cost_usd") * 10000) / 10000,
          avgLatencyMs: Math.round(numVal(r, "avg_latency_ms")),
        })),
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /tenants — Per-tenant breakdown
// ---------------------------------------------------------------------------
app.get("/tenants", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        index1 AS tenant,
        blob3 AS product,
        SUM(_sample_interval) AS requests,
        SUM(double2 * _sample_interval) AS tokens,
        SUM(double3 * _sample_interval) AS cost_usd
      FROM cortex_metrics
      WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY index1, blob3
      ORDER BY requests DESC
    `);

    return c.json({
      period: `${hours}h`,
      tenants: result.data.map((r) => ({
        tenantId: strVal(r, "tenant"),
        product: strVal(r, "product"),
        requests: Math.round(numVal(r, "requests")),
        tokens: Math.round(numVal(r, "tokens")),
        costUsd: Math.round(numVal(r, "cost_usd") * 10000) / 10000,
      })),
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /errors — Recent errors
// ---------------------------------------------------------------------------
app.get("/errors", async (c) => {
  try {
    const client = getClient(c.env);
    const hours = parseHours(c.req.query("hours"));

    const result: AnalyticsResult = await client.query(`
      SELECT
        timestamp,
        blob1 AS event,
        blob4 AS skill,
        blob6 AS error,
        blob2 AS request_id
      FROM cortex_metrics
      WHERE blob5 = 'error' AND blob6 != '' AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      ORDER BY timestamp DESC
      LIMIT 50
    `);

    return c.json({
      period: `${hours}h`,
      errors: result.data.map((r) => ({
        timestamp: strVal(r, "timestamp"),
        event: strVal(r, "event"),
        skill: strVal(r, "skill"),
        error: strVal(r, "error"),
        requestId: strVal(r, "request_id"),
      })),
    });
  } catch (err) {
    if (err instanceof ConfigError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Query failed" }, 500);
  }
});

export default app;
