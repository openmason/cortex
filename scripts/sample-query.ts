/**
 * Sample query — runs the Cortex API in-process with mocked backends.
 *
 * Usage:  npx tsx scripts/sample-query.ts
 */

// Mock fetch before importing the app
const originalFetch = globalThis.fetch;

let fetchCallIndex = 0;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  fetchCallIndex++;

  // --- LLM Proxy: chat completions ---
  if (urlStr.includes("/v1/chat/completions")) {
    // Turn 1: LLM calls findSkill
    if (fetchCallIndex === 1) {
      return new Response(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", created: Date.now(),
        model: "cognium/claude-sonnet-latest",
        choices: [{
          index: 0,
          message: {
            role: "assistant", content: null,
            tool_calls: [{
              id: "call-1", type: "function",
              function: { name: "findSkill", arguments: JSON.stringify({ query: "check rust dependencies for vulnerabilities" }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      }));
    }
    // Turn 2: LLM calls buildPlan
    if (fetchCallIndex === 3) {
      return new Response(JSON.stringify({
        id: "chatcmpl-2", object: "chat.completion", created: Date.now(),
        model: "cognium/claude-sonnet-latest",
        choices: [{
          index: 0,
          message: {
            role: "assistant", content: null,
            tool_calls: [{
              id: "call-2", type: "function",
              function: {
                name: "buildPlan",
                arguments: JSON.stringify({
                  steps: [{ skillId: "skill-cargo-audit", skillSlug: "cargo-audit", onError: "fail" }],
                  reasoning: "Found cargo-audit skill to scan Rust dependencies for known vulnerabilities.",
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 400, completion_tokens: 50, total_tokens: 450 },
      }));
    }
    // Turn 3: LLM final summary
    return new Response(JSON.stringify({
      id: "chatcmpl-3", object: "chat.completion", created: Date.now(),
      model: "cognium/claude-sonnet-latest",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "I'll run cargo-audit to scan your Rust dependencies for known security vulnerabilities. The plan has 1 step and requires your approval before execution.",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 },
    }));
  }

  // --- Runics: skill search ---
  if (urlStr.includes("/v1/search")) {
    return new Response(JSON.stringify({
      results: [{
        id: "skill-cargo-audit",
        slug: "cargo-audit",
        version: "2.1.0",
        name: "Cargo Audit",
        executionLayer: "container",
        trustScore: 0.92,
        verificationTier: "verified",
        trustBadge: "upstream",
        status: "published",
        skillType: "atomic",
        capabilitiesRequired: ["filesystem", "git"],
        r2BundleKey: "skills/cargo-audit/2.1.0/bundle.tar.gz",
        runCount: 1247,
        lastRunAt: "2026-03-07T18:30:00Z",
      }],
      confidence: "high",
      enriched: false,
      composition: { detected: false, parts: [] },
      meta: { latencyMs: 42, tier: 1, cacheHit: false, llmInvoked: false },
    }));
  }

  // --- Fallback ---
  return new Response(JSON.stringify({ ok: true }));
}) as typeof fetch;

// Shim cloudflare:workers for Node
// @ts-ignore
await import("module").then((m) => {
  const mod = m.default || m;
  if (mod.register) {
    // Node >=20.6 loader hooks — not needed here, we'll use a simpler approach
  }
});

// Provide a minimal DurableObject shim so the import chain works
// @ts-ignore
globalThis.__cloudflare_workers_shim = true;

// Now import and run
async function main() {
  // Dynamically build a mini Hono app that mirrors the routes without the DO export
  const { Hono } = await import("hono");
  const { cors } = await import("hono/cors");

  // We need to bypass the cloudflare:workers import in durable-object.ts.
  // Import only the pieces we need directly.
  const runRoutes = (await import("../src/routes/run")).default;
  const healthRoutes = (await import("../src/routes/health")).default;

  const app = new Hono();
  app.use("*", cors());
  app.route("/v1", runRoutes);
  app.route("/", healthRoutes);
  app.get("/", (c: any) => c.json({ name: "cortex", version: "0.1.0" }));

  const mockEnv = {
    SESSION_CACHE: {},
    WORKFLOW_STATE: {
      _store: new Map<string, string>(),
      put(key: string, value: string) { this._store.set(key, value); },
      get(key: string) { return this._store.get(key) ?? null; },
    },
    HYPERDRIVE: {},
    R2_BUCKET: { get: () => null },
    FORGE_QUEUE: { send: () => {} },
    COGNIUM_QUEUE: { send: () => {} },
    AI: {},
    WORKFLOW_DO: {},
    ENVIRONMENT: "local",
    RUNICS_URL: "https://runics.phantoms.workers.dev",
    COGNIUM_URL: "https://circle.cognium.net",
    DAYTONA_URL: "https://api.daytona.io",
    LLMPROXY_URL: "https://llmproxy.xus.one",
    LLMPROXY_API_KEY: "mock-key",
    LLM_MODEL: "cognium/claude-sonnet-latest",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    DAYTONA_API_KEY: "mock-key",
    DATABASE_URL: "postgresql://mock",
  };

  const ctx = { waitUntil: () => {} };

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Cortex — Sample Query (mocked backends)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // --- POST /v1/run ---
  console.log("\n>> POST /v1/run");
  console.log('   prompt: "check rust dependencies for vulnerabilities"');
  console.log("   product: controlcenter\n");

  const res = await app.fetch(
    new Request("http://localhost/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "check rust dependencies for vulnerabilities",
        tenantId: "tenant-openmason",
        userId: "eyal",
        product: "controlcenter",
      }),
    }),
    mockEnv,
    ctx,
  );

  const body = await res.json();
  console.log(`<< ${res.status}`);
  console.log(JSON.stringify(body, null, 2));

  // --- GET /v1/run/:id ---
  if ((body as any).workflowId) {
    console.log(`\n>> GET /v1/run/${(body as any).workflowId}`);
    const stateRes = await app.fetch(
      new Request(`http://localhost/v1/run/${(body as any).workflowId}`),
      mockEnv,
      ctx,
    );
    const stateBody = await stateRes.json();
    console.log(`<< ${stateRes.status}`);
    console.log(JSON.stringify(stateBody, null, 2));
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(console.error);
