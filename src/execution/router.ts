import type { Env, ExecutionLayer, ExecutionResult, SkillReference, SandboxResult } from "../types";
import { DaytonaClient } from "../clients/daytona";
import { WorkerDispatch } from "./worker-dispatch";

/**
 * Execution Router — maps skill.execution_layer to the right runtime.
 *
 * L0: Remote MCP   — HTTP call to external server (0ms boot, $0)
 * L1: Instructions  — LLM reads SKILL.md, uses built-in tools (0ms boot, $0 infra)
 * L2: Worker        — pure function on Cloudflare Workers (<5ms boot, ~$0.00001)
 * L3: Container     — Daytona sandbox, boot→run→destroy (~90ms boot, ~$0.001-0.10)
 */
export class ExecutionRouter {
  private daytona: DaytonaClient;
  private workerDispatch: WorkerDispatch;

  constructor(private env: Env) {
    this.daytona = new DaytonaClient(env);
    this.workerDispatch = new WorkerDispatch(env);
  }

  async execute(
    skill: SkillReference,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const start = Date.now();

    try {
      switch (skill.executionLayer) {
        case "mcp-remote":
          return await this.executeL0(skill, input, start);

        case "instructions":
          return await this.executeL1(skill, input, start);

        case "worker":
          return await this.executeL2(skill, input, start);

        case "container":
          return await this.executeL3(skill, input, start);

        case "composite":
          // Composites are expanded by the supervisor — they should not
          // arrive here directly. If they do, error.
          return {
            success: false,
            output: null,
            durationMs: Date.now() - start,
            layer: skill.executionLayer,
            error: "Composite skills must be expanded by the supervisor before execution",
          };

        default:
          return {
            success: false,
            output: null,
            durationMs: Date.now() - start,
            layer: skill.executionLayer,
            error: `Unknown execution layer: ${skill.executionLayer}`,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: skill.executionLayer,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * L0: Remote MCP — HTTP call to external MCP server.
   * The skill has an mcpUrl. We POST the tool call to it.
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
   * The LLM executes this itself using Mastra built-in tools.
   */
  private async executeL1(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    if (!skill.skillMd) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "instructions",
        error: "Instructions skill missing skillMd",
      };
    }

    // L1 returns the instructions — the supervisor LLM reads and follows them
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
   * L2: Worker — execute a pure JS/TS function on Cloudflare Workers.
   * The skill's code bundle is loaded from R2 and executed via WorkerDispatch.
   */
  private async executeL2(
    skill: SkillReference,
    input: Record<string, unknown>,
    _start: number,
  ): Promise<ExecutionResult> {
    return this.workerDispatch.execute(skill, input);
  }

  /**
   * L3: Container — Daytona sandbox. Boot, run, destroy.
   */
  private async executeL3(
    skill: SkillReference,
    input: Record<string, unknown>,
    start: number,
  ): Promise<ExecutionResult> {
    if (!skill.r2BundleKey) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        layer: "container",
        error: "Container skill missing r2BundleKey",
      };
    }

    const sandboxResult: SandboxResult = await this.daytona.createSandbox({
      skillId: skill.id,
      bundleKey: skill.r2BundleKey,
      command: JSON.stringify(input),
      timeoutMs: 60_000,
    });

    return {
      success: sandboxResult.exitCode === 0,
      output: {
        stdout: sandboxResult.stdout,
        stderr: sandboxResult.stderr,
        exitCode: sandboxResult.exitCode,
      },
      durationMs: Date.now() - start,
      layer: "container",
      error: sandboxResult.exitCode !== 0 ? sandboxResult.stderr : undefined,
    };
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
