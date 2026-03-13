import type { Env, ExecutionLayer, ExecutionResult, SkillReference } from "../types";
import { DaytonaClient } from "../clients/daytona";
import { WorkerDispatch } from "./worker-dispatch";
import type { LLMClient } from "../clients/llm";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

/**
 * Execution Router — maps skill.execution_layer to the right runtime.
 *
 * L0: Remote MCP   — HTTP call to external server (0ms boot, $0)
 * L1: Instructions  — LLM reads SKILL.md, uses built-in tools (0ms boot, $0 infra)
 * L2: Worker        — pure function on Cloudflare Workers (<5ms boot, ~$0.00001)
 * L3: Container     — Daytona sandbox, boot→run→destroy (~90ms boot, ~$0.001-0.10)
 *
 * Codegen fallback: when a skill has no bundle (mcpUrl, skillMd, r2BundleKey all null),
 * the router asks the LLM to generate code and executes it in a Daytona sandbox.
 */
export class ExecutionRouter {
  private daytona: DaytonaClient;
  private workerDispatch: WorkerDispatch;
  private llm: LLMClient | null;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(env: Env, llm?: LLMClient, log?: Logger, metrics?: Metrics) {
    this.daytona = new DaytonaClient(env, log?.child({ module: "daytona" }), metrics);
    this.workerDispatch = new WorkerDispatch(env);
    this.llm = llm ?? null;
    this.log = log;
    this.metrics = metrics;
  }

  async execute(
    skill: SkillReference,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const start = Date.now();

    try {
      let result: ExecutionResult;

      switch (skill.executionLayer) {
        case "mcp-remote":
          result = await this.executeL0(skill, input, start);
          break;

        case "instructions":
          result = await this.executeL1(skill, input, start);
          break;

        case "worker": {
          const workerResult = await this.workerDispatch.execute(skill, input);
          // If worker failed because bundle not found, try codegen fallback
          if (!workerResult.success && workerResult.error?.includes("Bundle not found") && this.llm) {
            result = await this.executeCodegen(skill, input, start);
          } else {
            result = workerResult;
          }
          break;
        }

        case "container":
          result = await this.executeL3(skill, input, start);
          break;

        case "composite":
          result = {
            success: false,
            output: null,
            durationMs: Date.now() - start,
            layer: skill.executionLayer,
            error: "Composite skills must be expanded by the supervisor before execution",
          };
          break;

        default:
          result = {
            success: false,
            output: null,
            durationMs: Date.now() - start,
            layer: skill.executionLayer,
            error: `Unknown execution layer: ${skill.executionLayer}`,
          };
      }

      this.metrics?.write("skill_exec", {
        skillSlug: skill.slug,
        status: result.success ? "ok" : "error",
        durationMs: result.durationMs,
        error: result.error,
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      this.metrics?.write("skill_exec", {
        skillSlug: skill.slug,
        status: "error",
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        output: null,
        durationMs,
        layer: skill.executionLayer,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * L0: Remote MCP — HTTP call to external MCP server.
   */
  private async executeL0(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    if (!skill.mcpUrl) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "mcp-remote",
        error: "MCP skill missing mcpUrl",
      };
    }

    const res = await fetch(skill.mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: skill.slug,
          arguments: input,
        },
        id: crypto.randomUUID(),
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "mcp-remote",
        error: `MCP server returned ${res.status}: ${await res.text()}`,
      };
    }

    const rpcResult: { result?: unknown; error?: { message: string } } = await res.json();

    if (rpcResult.error) {
      return {
        success: false,
        output: rpcResult.error,
        durationMs: Date.now() - start,
        layer: "mcp-remote",
        error: rpcResult.error.message,
      };
    }

    return {
      success: true,
      output: rpcResult.result,
      durationMs: Date.now() - start,
      layer: "mcp-remote",
    };
  }

  /**
   * L1: Instructions — return the SKILL.md for the LLM to follow.
   */
  private async executeL1(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    if (!skill.skillMd) {
      // No instructions — try codegen fallback
      if (this.llm) {
        return await this.executeCodegen(skill, input, start);
      }
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "instructions",
        error: "Instructions skill missing skillMd",
      };
    }

    return {
      success: true,
      output: {
        type: "instructions",
        skillMd: skill.skillMd,
        input,
        message: `Follow these instructions to complete the task. Input: ${JSON.stringify(input)}`,
      },
      durationMs: Date.now() - start,
      layer: "instructions",
    };
  }

  /**
   * L3: Container — Daytona sandbox. Create → upload bundle → execute → destroy.
   */
  private async executeL3(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    // If no bundle, use codegen fallback
    if (!skill.r2BundleKey && this.llm) {
      return await this.executeCodegen(skill, input, start);
    }

    const result = await this.daytona.execute({
      skillId: skill.id,
      command: typeof input.command === "string"
        ? input.command
        : `node /workspace/${skill.r2BundleKey?.split("/").pop() ?? "bundle.js"}`,
      bundleKey: skill.r2BundleKey,
      env: input.env as Record<string, string> | undefined,
      timeoutSecs: 60,
    });

    // If bundle not found in R2, try codegen
    if (result.exitCode !== 0 && result.stderr?.includes("Bundle not found") && this.llm) {
      return await this.executeCodegen(skill, input, start);
    }

    return {
      success: result.exitCode === 0,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      durationMs: Date.now() - start,
      layer: "container",
      error: result.exitCode !== 0 ? result.stderr : undefined,
    };
  }

  /**
   * Codegen fallback — LLM generates code, Daytona executes it.
   *
   * Used when a skill has no executable bundle (no mcpUrl, no skillMd, no r2BundleKey).
   * The LLM generates a self-contained script based on the skill description and input,
   * then Daytona runs it in a sandbox.
   */
  private async executeCodegen(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    if (!this.llm) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "container",
        error: "Codegen fallback requires LLM client",
      };
    }

    this.log?.info("Codegen fallback", { skillSlug: skill.slug });

    // 1. Ask the LLM to generate code
    const description = (skill as any).agentSummary ?? (skill as any).description ?? skill.name;
    const prompt = `You are a code generator. Your ONLY output must be raw JavaScript code — no markdown, no fences, no explanation, no comments before or after the code.

Task: write a self-contained Node.js script.

SKILL: ${skill.slug}
DESCRIPTION: ${description}
INPUT: ${JSON.stringify(input)}

Rules:
1. Output raw JavaScript only. Do NOT wrap in \`\`\` fences.
2. Self-contained — no require() for external packages, only Node.js built-ins (http, https, fs, path, os, crypto, child_process, url, util, stream, zlib).
3. Define the input inline: const input = ${JSON.stringify(input)};
4. Print the result to stdout as JSON: console.log(JSON.stringify(result));
5. On failure, write to stderr and exit: process.stderr.write(error); process.exit(1);
6. The script must complete in under 25 seconds.`;

    let code: string;
    try {
      const response = await this.llm.chat({
        messages: [
          { role: "system", content: "You are a code generator. Output ONLY valid JavaScript code. Never use markdown formatting. Never include ``` fences." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 4096,
      });
      code = response.choices[0]?.message?.content ?? "";
      if (!code.trim()) {
        throw new Error("LLM returned empty code");
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "container",
        error: `Codegen failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    code = this.stripFences(code);

    this.metrics?.write("codegen", { skillSlug: skill.slug, durationMs: Date.now() - start });

    // 2. Execute in Daytona sandbox using codeRun (no file writing needed)
    let result = await this.daytona.runCode(code, 30);

    // 3. If execution failed, retry once with the error fed back to the LLM
    if (result.exitCode !== 0 && this.llm) {
      const errorOutput = (result.stderr || result.stdout || "").slice(0, 1000);
      try {
        const retryResponse = await this.llm.chat({
          messages: [
            { role: "system", content: "You are a code generator. Output ONLY valid JavaScript code. Never use markdown formatting. Never include ``` fences." },
            { role: "user", content: prompt },
            { role: "assistant", content: code },
            { role: "user", content: `The script failed with this error:\n\n${errorOutput}\n\nFix the code. Output ONLY the corrected JavaScript, no explanation.` },
          ],
          temperature: 0,
          max_tokens: 4096,
        });
        const fixedCode = this.stripFences(retryResponse.choices[0]?.message?.content ?? "");
        if (fixedCode.trim()) {
          result = await this.daytona.runCode(fixedCode, 30);
        }
      } catch {
        // Retry is best-effort — fall through with original result
      }
    }

    return {
      success: result.exitCode === 0,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        codegenerated: true,
      },
      durationMs: Date.now() - start,
      layer: "container",
      error: result.exitCode !== 0 ? (result.stderr || result.stdout || "Execution failed") : undefined,
    };
  }

  /** Strip markdown fences from LLM-generated code */
  private stripFences(code: string): string {
    return code
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/\n?```$/gm, "")
      .replace(/^```$/gm, "")
      .trim();
  }
}

/**
 * Routing decision tree (from spec):
 *
 * Is the skill a remote MCP server?
 * ├─ YES → L0
 * └─ NO → Needs filesystem, binaries, or browser?
 *          ├─ YES → L3 (Daytona)
 *          └─ NO → Pure JS/TS, no heavy deps?
 *                   ├─ YES → L2 (Worker)
 *                   └─ NO → Just instructions?
 *                            ├─ YES → L1
 *                            └─ NO → L2
 */
export function resolveExecutionLayer(skill: {
  executionLayer?: ExecutionLayer;
  mcpUrl?: string;
  skillMd?: string;
  capabilitiesRequired?: string[];
}): ExecutionLayer {
  // Explicit layer wins
  if (skill.executionLayer) return skill.executionLayer;

  // Remote MCP
  if (skill.mcpUrl) return "mcp-remote";

  // Heavy capabilities → container
  const heavyCaps = ["git", "filesystem", "browser", "binary", "docker"];
  if (skill.capabilitiesRequired?.some((c) => heavyCaps.includes(c))) {
    return "container";
  }

  // Just instructions
  if (skill.skillMd && !skill.capabilitiesRequired?.length) {
    return "instructions";
  }

  // Default: worker
  return "worker";
}
