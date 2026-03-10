import type { Env, ExecutionResult, SkillReference } from "../types";
import { BUILTIN_SKILLS } from "./builtin-skills";

/**
 * L2 Worker Dispatch — execute pure JS/TS skill functions on Cloudflare Workers.
 *
 * Skills at L2 are pure functions bundled as ESM modules, stored in R2.
 * The dispatch mechanism:
 *
 * 1. Fetch the skill bundle from R2
 * 2. Parse the module and extract the `execute` export
 * 3. Run the function with the provided input
 * 4. Return structured output
 *
 * Bundle format (R2):
 *   skills/{slug}/{version}/bundle.js
 *
 * Expected module export:
 *   export async function execute(input: Record<string, unknown>): Promise<unknown>
 *
 * For production at scale, this would use Cloudflare's Worker-to-Worker
 * service bindings or dynamic dispatch (dispatch namespaces). For now,
 * we load and evaluate the bundle inline via the module system.
 */

export interface WorkerSkillModule {
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  metadata?: {
    name: string;
    version: string;
    timeout?: number;
  };
}

export class WorkerDispatch {
  constructor(private env: Env) {}

  /**
   * Execute an L2 worker skill.
   */
  async execute(
    skill: SkillReference,
    input: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const start = Date.now();

    // Check built-in skills first
    const builtin = BUILTIN_SKILLS[skill.slug];
    if (builtin) {
      try {
        const output = await builtin(input);
        return { success: true, output, durationMs: Date.now() - start, layer: "worker" };
      } catch (err) {
        return {
          success: false, output: null, durationMs: Date.now() - start, layer: "worker",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (!skill.r2BundleKey) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "worker",
        error: "Worker skill missing r2BundleKey",
      };
    }

    // Fetch the compiled skill module from R2
    const bundleObj = await this.env.R2_BUCKET.get(skill.r2BundleKey);
    if (!bundleObj) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "worker",
        error: `Bundle not found in R2: ${skill.r2BundleKey}`,
      };
    }

    try {
      const bundleSource = await bundleObj.text();
      const output = await this.executeSandboxed(bundleSource, input, skill);

      return {
        success: true,
        output,
        durationMs: Date.now() - start,
        layer: "worker",
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "worker",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute the skill bundle.
   *
   * Cloudflare Workers disallow `new Function()` / `eval()`, so we
   * use a simple JSON-protocol approach: the bundle is a self-contained
   * CommonJS module. We load it via a data-URL dynamic import.
   *
   * If dynamic import isn't available (Workers limitations), we fall back
   * to a fetch-based self-invocation pattern.
   */
  private async executeSandboxed(
    bundleSource: string,
    input: Record<string, unknown>,
    skill: SkillReference,
  ): Promise<unknown> {
    // Convert CJS bundle to ESM wrapper for dynamic import
    const esmWrapper = `
      const __exports = {};
      const module = { exports: __exports };
      const exports = __exports;
      ${bundleSource}
      export default __exports;
    `;

    try {
      // Attempt dynamic import via data URL (works in Node, may work in Workers)
      const dataUrl = `data:text/javascript;base64,${btoa(esmWrapper)}`;
      const mod = await import(/* @vite-ignore */ dataUrl);
      const skillModule = (mod.default ?? mod) as Partial<WorkerSkillModule>;

      if (typeof skillModule.execute !== "function") {
        throw new Error(
          `Skill bundle ${skill.slug}@${skill.version} does not export an 'execute' function`,
        );
      }

      const timeoutMs = skillModule.metadata?.timeout ?? 10_000;
      const result = await Promise.race([
        skillModule.execute(input),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Skill execution timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);

      return result;
    } catch (importErr) {
      // If dynamic import fails, try inline evaluation via Workers AI as fallback
      if (this.env.AI) {
        return this.executeViaAI(bundleSource, input, skill);
      }
      throw importErr;
    }
  }

  /**
   * Fallback: use Workers AI to execute the skill function.
   * Sends the bundle source + input to an LLM and asks it to execute.
   */
  private async executeViaAI(
    bundleSource: string,
    input: Record<string, unknown>,
    skill: SkillReference,
  ): Promise<unknown> {
    // Extract just the function body and run it logically
    // This is a last-resort for environments that block all code gen
    throw new Error(
      `Dynamic code execution is not available. Skill ${skill.slug} requires a service binding or pre-compiled worker.`,
    );
  }
}

/**
 * Validate a skill bundle before deployment.
 * Used by the publish pipeline to ensure bundles are well-formed.
 */
export async function validateBundle(
  bundleSource: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const wrappedSource = `
      const __exports = {};
      const module = { exports: __exports };
      const exports = __exports;
      ${bundleSource}
      return __exports;
    `;

    // eslint-disable-next-line no-new-func
    const moduleFactory = new Function(wrappedSource);
    const skillModule = moduleFactory() as Partial<WorkerSkillModule>;

    if (typeof skillModule.execute !== "function") {
      return { valid: false, error: "Bundle does not export an 'execute' function" };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Bundle parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
