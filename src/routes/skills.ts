import { Hono } from "hono";
import { z } from "zod";
import type { Env, AppVariables } from "../types";
import { RunicsClient } from "../clients/runics";
import { requireScope } from "../middleware/auth";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("*", requireScope("skills"));

// ---------------------------------------------------------------------------
// GET /v1/skills/composites — List composites for the authenticated tenant
// ---------------------------------------------------------------------------
app.get("/composites", async (c) => {
  const tenantId = c.get("tenantId");
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

  const runics = new RunicsClient(c.env);

  try {
    const userId = c.get("userId");
    const result = await runics.listComposites(tenantId, { status, limit, offset, userId });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to list composites" },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// GET /v1/skills/composites/:slug — Get composite detail with steps
// ---------------------------------------------------------------------------
app.get("/composites/:slug", async (c) => {
  const slug = c.req.param("slug");
  const version = c.req.query("version");

  const runics = new RunicsClient(c.env);

  try {
    const detail = await runics.getCompositeDetail(slug, version ?? undefined);

    if (!detail) {
      return c.json({ error: "Composite skill not found" }, 404);
    }

    return c.json(detail);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to get composite detail" },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// PATCH /v1/skills/composites/:slug — Update composite metadata
// ---------------------------------------------------------------------------
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(10).max(2000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  category: z.string().max(100).optional(),
  visibility: z.enum(["public", "team", "private"]).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided for update" },
);

app.patch("/composites/:slug", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = c.get("tenantId");
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const runics = new RunicsClient(c.env);

  try {
    const updated = await runics.updateComposite(slug, tenantId, parsed.data);
    return c.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update composite";
    const status = msg.includes("not found") ? 404
      : msg.includes("Unauthorized") ? 403
      : 502;
    return c.json({ error: msg }, status);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/skills/composites/:slug/deprecate — Deprecate a composite
// ---------------------------------------------------------------------------
const deprecateSchema = z.object({
  reason: z.string().max(500).optional(),
  replacementSkillSlug: z.string().max(200).optional(),
});

app.post("/composites/:slug/deprecate", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = c.get("tenantId");
  const body = await c.req.json();
  const parsed = deprecateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const runics = new RunicsClient(c.env);

  try {
    const result = await runics.deprecateComposite(
      slug,
      tenantId,
      parsed.data.reason,
      parsed.data.replacementSkillSlug,
    );
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to deprecate composite";
    const status = msg.includes("not found") ? 404
      : msg.includes("Unauthorized") ? 403
      : 502;
    return c.json({ error: msg }, status);
  }
});

// ---------------------------------------------------------------------------
// POST /v1/skills/composites/:slug/fork — Fork a composite
// ---------------------------------------------------------------------------
const forkSchema = z.object({
  changes: z.array(z.string().min(1).max(200)).min(1).max(20),
  modifications: z.object({
    removeSteps: z.array(z.number().int().min(0)).optional(),
    reorderSteps: z.array(z.number().int().min(0)).optional(),
    swapSteps: z.array(z.object({
      stepOrder: z.number().int().min(0),
      newSkillSlug: z.string().min(1),
      newSkillVersion: z.string().optional(),
    })).optional(),
    addSteps: z.array(z.object({
      afterStepOrder: z.number().int().min(0),
      skillSlug: z.string().min(1),
      skillVersion: z.string().optional(),
      stepName: z.string().min(1).max(200),
      inputMapping: z.record(z.unknown()).optional(),
      onError: z.enum(["fail", "skip", "retry"]).optional(),
    })).optional(),
  }).optional(),
});

app.post("/composites/:slug/fork", async (c) => {
  const slug = c.req.param("slug");
  const tenantId = c.get("tenantId");
  const userId = c.get("userId");
  const body = await c.req.json();
  const parsed = forkSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  }

  const runics = new RunicsClient(c.env);

  try {
    const result = await runics.forkComposite(slug, tenantId, userId, parsed.data);
    return c.json(result, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fork composite";
    const status = msg.includes("not found") ? 404 : 502;
    return c.json({ error: msg }, status);
  }
});

export default app;
