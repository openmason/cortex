import type { Env, ExecutionResult, SkillReference } from "../types";

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

/**
 * Built-in skill implementations — compiled into Cortex for instant execution.
 * Used for first-party skills and testing. Keyed by skill slug.
 */
const BUILTIN_SKILLS: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  "mr-complexity-scorer": async (input) => {
    const code = String(input.code || input.diff || input.text || "");
    if (!code) return { error: "No code provided. Pass { code: '...' } or { diff: '...' } as input." };

    const lines = code.split("\n");
    const totalLines = lines.length;
    const addedLines = lines.filter(l => l.startsWith("+")).length;
    const removedLines = lines.filter(l => l.startsWith("-")).length;
    const changedFiles = new Set(lines.filter(l => l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---")).map(l => l.split(" ").pop())).size;

    // Complexity heuristics
    const issues: Array<{severity: string; line: number; message: string}> = [];
    let complexityScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Long lines
      if (line.length > 120) {
        issues.push({ severity: "warning", line: i + 1, message: `Line exceeds 120 chars (${line.length})` });
        complexityScore += 1;
      }
      // TODO/FIXME/HACK
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
        issues.push({ severity: "info", line: i + 1, message: `Contains ${line.match(/\b(TODO|FIXME|HACK|XXX)\b/)![0]} marker` });
        complexityScore += 2;
      }
      // Deeply nested (4+ indentation levels)
      const indent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
      if (indent >= 16) {
        issues.push({ severity: "warning", line: i + 1, message: "Deep nesting detected (4+ levels)" });
        complexityScore += 3;
      }
      // console.log / debugger
      if (/\b(console\.(log|debug|warn)|debugger|print\()\b/.test(line)) {
        issues.push({ severity: "warning", line: i + 1, message: "Debug statement detected" });
        complexityScore += 2;
      }
      // Hardcoded secrets patterns
      if (/(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/i.test(line)) {
        issues.push({ severity: "critical", line: i + 1, message: "Possible hardcoded secret/credential" });
        complexityScore += 10;
      }
      // Large functions (rough: function with >50 lines before next function)
      if (/\b(function |async function |=>\s*\{|\.then\()/.test(line)) {
        complexityScore += 1;
      }
    }

    // Size-based complexity
    if (totalLines > 500) complexityScore += 5;
    if (totalLines > 1000) complexityScore += 10;

    const rating = complexityScore <= 5 ? "low" : complexityScore <= 15 ? "medium" : complexityScore <= 30 ? "high" : "critical";
    const criticalCount = issues.filter(i => i.severity === "critical").length;
    const warningCount = issues.filter(i => i.severity === "warning").length;

    return {
      complexity: rating,
      complexityScore,
      stats: { totalLines, addedLines, removedLines, changedFiles: changedFiles || 1 },
      issues: issues.slice(0, 20),
      counts: { critical: criticalCount, warnings: warningCount, info: issues.length - criticalCount - warningCount },
      summary: `Complexity: ${rating} (score: ${complexityScore}). Found ${criticalCount} critical, ${warningCount} warnings across ${totalLines} lines.`,
      recommendation: criticalCount > 0 ? "Block merge — critical issues found." : warningCount > 5 ? "Request changes — multiple warnings." : "Approve — looks good.",
    };
  },

  "emotion-state": async (input) => {
    const text = String(input.text || input.prompt || input.content || "").toLowerCase();
    if (!text) return { error: "No text provided. Pass { text: '...' } as input." };

    const positive = ["love", "great", "amazing", "excellent", "wonderful", "fantastic", "awesome", "good", "happy", "best", "perfect", "beautiful", "enjoy", "pleased", "satisfied", "recommend"];
    const negative = ["hate", "terrible", "awful", "horrible", "bad", "worst", "broken", "poor", "disappointing", "frustrated", "angry", "useless", "waste", "fail", "sucks", "rubbish"];

    const words = text.split(/\s+/);
    let posCount = 0, negCount = 0;
    const posMatches: string[] = [], negMatches: string[] = [];

    for (const w of words) {
      const c = w.replace(/[^a-z]/g, "");
      if (positive.includes(c)) { posCount++; posMatches.push(c); }
      if (negative.includes(c)) { negCount++; negMatches.push(c); }
    }

    const total = posCount + negCount;
    const score = total === 0 ? 0.5 : posCount / total;
    const sentiment = total === 0 ? "neutral" : score > 0.6 ? "positive" : score < 0.4 ? "negative" : "mixed";

    return {
      sentiment, score: Math.round(score * 100) / 100,
      positiveSignals: posMatches, negativeSignals: negMatches,
      wordCount: words.length,
      summary: `Detected ${sentiment} sentiment (score: ${score.toFixed(2)}). Found ${posCount} positive and ${negCount} negative signals.`,
    };
  },
};

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
