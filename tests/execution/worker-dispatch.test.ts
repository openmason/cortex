import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerDispatch, validateBundle } from "../../src/execution/worker-dispatch";
import type { Env, SkillReference } from "../../src/types";

function makeSkill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    id: "skill-1",
    slug: "json-transform",
    version: "1.0.0",
    name: "JSON Transform",
    executionLayer: "worker",
    trustScore: 0.85,
    verificationTier: "verified",
    trustBadge: null,
    status: "published",
    skillType: "atomic",
    runCount: 10,
    r2BundleKey: "skills/json-transform/1.0.0/bundle.js",
    ...overrides,
  };
}

describe("WorkerDispatch", () => {
  let dispatch: WorkerDispatch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should execute a valid skill bundle", async () => {
    const bundleSource = `
      exports.execute = async function(input) {
        return { transformed: input.data.map(x => x * 2) };
      };
    `;

    const env = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue({
          text: () => Promise.resolve(bundleSource),
        }),
      },
    } as unknown as Env;

    dispatch = new WorkerDispatch(env);
    const result = await dispatch.execute(makeSkill(), { data: [1, 2, 3] });

    expect(result.success).toBe(true);
    expect(result.layer).toBe("worker");
    expect((result.output as any).transformed).toEqual([2, 4, 6]);
  });

  it("should fail if bundle has no execute export", async () => {
    const bundleSource = `
      exports.doSomething = async function(input) { return input; };
    `;

    const env = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue({
          text: () => Promise.resolve(bundleSource),
        }),
      },
    } as unknown as Env;

    dispatch = new WorkerDispatch(env);
    const result = await dispatch.execute(makeSkill(), {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not export an 'execute' function");
  });

  it("should fail if R2 bundle not found", async () => {
    const env = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Env;

    dispatch = new WorkerDispatch(env);
    const result = await dispatch.execute(makeSkill(), {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Bundle not found");
  });

  it("should fail if r2BundleKey is missing", async () => {
    const env = { R2_BUCKET: {} } as unknown as Env;
    dispatch = new WorkerDispatch(env);
    const skill = makeSkill({ r2BundleKey: undefined });

    const result = await dispatch.execute(skill, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing r2BundleKey");
  });

  it("should handle bundles that throw errors", async () => {
    const bundleSource = `
      exports.execute = async function(input) {
        throw new Error("skill exploded");
      };
    `;

    const env = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue({
          text: () => Promise.resolve(bundleSource),
        }),
      },
    } as unknown as Env;

    dispatch = new WorkerDispatch(env);
    const result = await dispatch.execute(makeSkill(), {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("skill exploded");
  });

  it("should handle synchronous execute functions", async () => {
    const bundleSource = `
      exports.execute = function(input) {
        return Promise.resolve({ sum: input.a + input.b });
      };
    `;

    const env = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue({
          text: () => Promise.resolve(bundleSource),
        }),
      },
    } as unknown as Env;

    dispatch = new WorkerDispatch(env);
    const result = await dispatch.execute(makeSkill(), { a: 3, b: 7 });

    expect(result.success).toBe(true);
    expect((result.output as any).sum).toBe(10);
  });
});

describe("validateBundle", () => {
  it("should validate a correct bundle", async () => {
    const source = `exports.execute = async function(input) { return input; };`;
    const result = await validateBundle(source);
    expect(result.valid).toBe(true);
  });

  it("should reject a bundle without execute export", async () => {
    const source = `exports.run = async function(input) { return input; };`;
    const result = await validateBundle(source);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not export an 'execute' function");
  });

  it("should reject invalid JS", async () => {
    const source = `this is not javascript {{{`;
    const result = await validateBundle(source);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Bundle parse error");
  });
});
