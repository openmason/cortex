/**
 * E2E Smoke Test — validates the live Cortex deployment.
 *
 * Usage:
 *   ADMIN_SECRET=<secret> npx tsx scripts/smoke-test.ts
 *   ADMIN_SECRET=<secret> CORTEX_URL=https://cortex.example.com npx tsx scripts/smoke-test.ts
 */

const BASE_URL = process.env.CORTEX_URL || process.argv[2] || "https://cortex.phantoms.workers.dev";
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ANSI colors
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestResult {
  name: string;
  status: "pass" | "warn" | "fail";
  ms: number;
  detail: string;
}

interface State {
  apiKey?: string;
  workflowId?: string;
  hasWorkflowPlan?: boolean;
  scopeTestKey?: string;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function request(
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ status: number; body: any; ms: number }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { ...opts?.headers };
  if (opts?.body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15000);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const ms = Date.now() - start;
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms };
  } finally {
    clearTimeout(timeout);
  }
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_SECRET}` };
}

function apiAuth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRoot(): Promise<TestResult> {
  const { status, body, ms } = await request("GET", "/");
  if (status === 200 && body?.name === "cortex") {
    return { name: "GET /", status: "pass", ms, detail: `200 v${body.version}` };
  }
  return { name: "GET /", status: "fail", ms, detail: `${status} unexpected` };
}

async function testHealth(): Promise<TestResult> {
  const { status, body, ms } = await request("GET", "/health");
  if ((status === 200 || status === 503) && body?.status && body?.checks) {
    const s = body.status === "healthy" ? "pass" : "warn";
    return { name: "GET /health", status: s as "pass" | "warn", ms, detail: `${status} ${body.status}` };
  }
  return { name: "GET /health", status: "fail", ms, detail: `${status} bad shape` };
}

async function testCreateKey(state: State): Promise<TestResult> {
  const { status, body, ms } = await request("POST", "/admin/api-keys", {
    headers: adminAuth(),
    body: {
      tenantId: "smoke-test",
      userId: "smoke-bot",
      product: "bombastic",
      scopes: ["run", "sessions", "skills", "models"],
    },
  });
  if (status === 201 && body?.key?.startsWith("ctx_")) {
    state.apiKey = body.key;
    return { name: "POST /admin/api-keys", status: "pass", ms, detail: `201 key=${body.key.slice(0, 12)}...` };
  }
  return { name: "POST /admin/api-keys", status: "fail", ms, detail: `${status} ${JSON.stringify(body?.error ?? body)}` };
}

async function testRun(state: State): Promise<TestResult> {
  if (!state.apiKey) return { name: "POST /v1/run", status: "fail", ms: 0, detail: "skipped (no key)" };

  const { status, body, ms } = await request("POST", "/v1/run", {
    headers: apiAuth(state.apiKey),
    body: { prompt: "hello world" },
    timeoutMs: 30000,
  });
  if (status === 200 && body?.workflowId && body?.status) {
    state.workflowId = body.workflowId;
    state.hasWorkflowPlan = !!body.plan;
    return { name: "POST /v1/run", status: "pass", ms, detail: `200 wf=${body.workflowId.slice(0, 8)}... status=${body.status}` };
  }
  // 422 means workflow ran but failed (e.g. no skills found) — still structurally valid
  if (status === 422 && body?.workflowId) {
    state.workflowId = body.workflowId;
    state.hasWorkflowPlan = !!body.plan;
    return { name: "POST /v1/run", status: "warn", ms, detail: `422 wf=${body.workflowId.slice(0, 8)}... ${body.summary?.slice(0, 60) ?? ""}` };
  }
  return { name: "POST /v1/run", status: "fail", ms, detail: `${status} ${JSON.stringify(body?.error ?? body).slice(0, 100)}` };
}

async function testGetRun(state: State): Promise<TestResult> {
  if (!state.workflowId) return { name: "GET /v1/run/:id", status: "fail", ms: 0, detail: "skipped (no workflowId)" };

  // Direct LLM responses (no plan built) generate an ephemeral workflowId
  // that is never persisted — 404 is expected in that case.
  if (!state.hasWorkflowPlan) {
    return { name: "GET /v1/run/:id", status: "pass", ms: 0, detail: "skipped (direct LLM response, no persisted state)" };
  }

  const { status, body, ms } = await request("GET", `/v1/run/${state.workflowId}`, {
    headers: apiAuth(state.apiKey!),
  });
  if (status === 200 && body?.workflowId) {
    return { name: "GET /v1/run/:id", status: "pass", ms, detail: `200 status=${body.status}` };
  }
  return { name: "GET /v1/run/:id", status: "fail", ms, detail: `${status}` };
}

async function testSessions(state: State): Promise<TestResult> {
  if (!state.apiKey) return { name: "GET /v1/sessions", status: "fail", ms: 0, detail: "skipped (no key)" };

  const { status, body, ms } = await request("GET", "/v1/sessions", {
    headers: apiAuth(state.apiKey),
  });
  if (status === 200 && Array.isArray(body?.sessions)) {
    return { name: "GET /v1/sessions", status: "pass", ms, detail: `200 count=${body.sessions.length}` };
  }
  if (status === 500) {
    return { name: "GET /v1/sessions", status: "warn", ms, detail: "500 DB unavailable" };
  }
  return { name: "GET /v1/sessions", status: "fail", ms, detail: `${status}` };
}

async function testSkillsComposites(state: State): Promise<TestResult> {
  if (!state.apiKey) return { name: "GET /v1/skills/composites", status: "fail", ms: 0, detail: "skipped (no key)" };

  const { status, body, ms } = await request("GET", "/v1/skills/composites", {
    headers: apiAuth(state.apiKey),
  });
  if (status === 200) {
    return { name: "GET /v1/skills/composites", status: "pass", ms, detail: `200` };
  }
  if (status === 502) {
    return { name: "GET /v1/skills/composites", status: "warn", ms, detail: "502 Runics unavailable" };
  }
  return { name: "GET /v1/skills/composites", status: "fail", ms, detail: `${status}` };
}

async function testDeleteKey(state: State): Promise<TestResult> {
  if (!state.apiKey) return { name: "DELETE /admin/api-keys/:key", status: "fail", ms: 0, detail: "skipped (no key)" };

  const { status, body, ms } = await request("DELETE", `/admin/api-keys/${state.apiKey}`, {
    headers: adminAuth(),
  });
  state.apiKey = undefined;
  if (status === 200 && body?.deleted) {
    return { name: "DELETE /admin/api-keys/:key", status: "pass", ms, detail: "200 cleaned up" };
  }
  return { name: "DELETE /admin/api-keys/:key", status: "fail", ms, detail: `${status}` };
}

async function testScopeEnforcement(state: State): Promise<TestResult> {
  // Create a key with only "run" scope
  const { status: createStatus, body: createBody } = await request("POST", "/admin/api-keys", {
    headers: adminAuth(),
    body: {
      tenantId: "smoke-scope-test",
      userId: "smoke-bot",
      product: "bombastic",
      scopes: ["run"],
    },
  });

  if (createStatus !== 201 || !createBody?.key) {
    return { name: "Scope enforcement (403)", status: "fail", ms: 0, detail: `key creation failed: ${createStatus}` };
  }

  state.scopeTestKey = createBody.key;

  // Attempt to hit skills route (requires "skills" scope)
  const { status, body, ms } = await request("GET", "/v1/skills/composites", {
    headers: apiAuth(createBody.key),
  });

  // Clean up immediately
  await request("DELETE", `/admin/api-keys/${createBody.key}`, { headers: adminAuth() });
  state.scopeTestKey = undefined;

  if (status === 403 && body?.error?.includes("scope")) {
    return { name: "Scope enforcement (403)", status: "pass", ms, detail: "403 as expected" };
  }
  return { name: "Scope enforcement (403)", status: "fail", ms, detail: `expected 403, got ${status}` };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup(state: State): Promise<void> {
  if (state.apiKey) {
    await request("DELETE", `/admin/api-keys/${state.apiKey}`, { headers: adminAuth() }).catch(() => {});
  }
  if (state.scopeTestKey) {
    await request("DELETE", `/admin/api-keys/${state.scopeTestKey}`, { headers: adminAuth() }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!ADMIN_SECRET) {
    console.error(`${RED}Error: ADMIN_SECRET env var is required${RESET}`);
    console.error("Usage: ADMIN_SECRET=<secret> npx tsx scripts/smoke-test.ts");
    process.exit(1);
  }

  console.log(`\n== Cortex Smoke Test ==`);
  console.log(`Target: ${DIM}${BASE_URL}${RESET}\n`);

  const state: State = {};
  const results: TestResult[] = [];

  const tests = [
    () => testRoot(),
    () => testHealth(),
    () => testCreateKey(state),
    () => testRun(state),
    () => testGetRun(state),
    () => testSessions(state),
    () => testSkillsComposites(state),
    () => testDeleteKey(state),
    () => testScopeEnforcement(state),
  ];

  try {
    for (const test of tests) {
      const result = await test();
      results.push(result);

      const color = result.status === "pass" ? GREEN : result.status === "warn" ? YELLOW : RED;
      const tag = result.status.toUpperCase().padEnd(4);
      const name = result.name.padEnd(34);
      const timing = result.ms > 0 ? `${DIM}(${result.ms}ms)${RESET}` : "";
      console.log(`  ${color}[${tag}]${RESET} ${name} ${result.detail} ${timing}`);
    }
  } finally {
    await cleanup(state);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  console.log(
    `\nResults: ${GREEN}${passed} passed${RESET}, ${YELLOW}${warned} warn${RESET}, ${RED}${failed} failed${RESET}`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
