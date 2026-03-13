import { Daytona } from "@daytonaio/sdk";
import type { Env, SandboxRequest, SandboxResult } from "../types";
import type { Logger } from "../observability/logger";
import type { Metrics } from "../observability/metrics";

/**
 * DaytonaClient — manages sandbox lifecycle for L3 (container) execution.
 *
 * Uses the official @daytonaio/sdk. Each skill execution:
 *   1. Creates a sandbox (optionally from a snapshot)
 *   2. Uploads the skill bundle from R2
 *   3. Executes the command
 *   4. Collects stdout/stderr
 *   5. Destroys the sandbox
 */
export class DaytonaClient {
  private client: Daytona;
  private env: Env;
  private log?: Logger;
  private metrics?: Metrics;

  constructor(env: Env, log?: Logger, metrics?: Metrics) {
    this.env = env;
    this.log = log;
    this.metrics = metrics;
    this.client = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
      target: env.DAYTONA_TARGET ?? "us",
    });
  }

  /**
   * Run a skill in an ephemeral sandbox.
   * Creates → uploads bundle → executes → collects output → destroys.
   */
  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const start = Date.now();
    let sandbox;

    this.log?.info("Sandbox execute", { skillId: request.skillId, bundleKey: request.bundleKey, language: request.language });

    try {
      // 1. Create sandbox (use snapshot if provided for fast boot)
      const createOpts: Record<string, unknown> = {
        language: request.language ?? "typescript",
        envVars: request.env ?? {},
      };
      if (request.snapshot) {
        (createOpts as any).snapshot = request.snapshot;
      }

      sandbox = await this.client.create(createOpts as any);
      const bootMs = Date.now() - start;
      this.log?.debug("Sandbox created", { skillId: request.skillId, bootMs });

      // 2. Upload the skill bundle from R2 if a bundleKey is provided
      if (request.bundleKey) {
        const obj = await this.env.R2_BUCKET.get(request.bundleKey);
        if (!obj) {
          this.log?.warn("Bundle not found in R2", { bundleKey: request.bundleKey });
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Bundle not found in R2: ${request.bundleKey}`,
            durationMs: Date.now() - start,
          };
        }

        const bundleBytes = await obj.arrayBuffer();
        const bundlePath = `/workspace/${request.bundleKey.split("/").pop() ?? "bundle.js"}`;
        await sandbox.fs.uploadFile(bundlePath, new Uint8Array(bundleBytes));
      }

      // 3. Execute the command
      const response = await sandbox.process.executeCommand(
        request.command,
        request.cwd ?? "/workspace",
        request.env,
        request.timeoutSecs ?? 60,
      );

      const durationMs = Date.now() - start;
      const exitCode = response.exitCode ?? 0;
      this.log?.info("Sandbox execution completed", { skillId: request.skillId, exitCode, durationMs });
      this.metrics?.write("sandbox_exec", { skillSlug: request.skillId, status: exitCode === 0 ? "ok" : "error", durationMs });

      return {
        exitCode,
        stdout: response.result ?? "",
        stderr: "",
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log?.error("Sandbox execution failed", { skillId: request.skillId, error: errMsg, durationMs });
      this.metrics?.write("sandbox_exec", { skillSlug: request.skillId, status: "error", durationMs, error: errMsg });
      return {
        exitCode: 1,
        stdout: "",
        stderr: errMsg,
        durationMs,
      };
    } finally {
      // 4. Always clean up the sandbox
      if (sandbox) {
        try {
          await sandbox.delete();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  /**
   * Clean up any orphaned sandboxes. Called by the cron handler.
   * Returns the number of sandboxes deleted.
   */
  async cleanup(): Promise<number> {
    try {
      const result = await this.client.list();
      const sandboxes = result.items ?? [];
      let deleted = 0;
      for (const s of sandboxes) {
        try {
          await s.delete();
          deleted++;
        } catch {
          // Best-effort — skip if delete fails
        }
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  /**
   * Run code directly in a sandbox using the SDK's codeRun method.
   * Creates sandbox → runs code → collects output → destroys sandbox.
   */
  async runCode(code: string, timeoutSecs = 30): Promise<SandboxResult> {
    const start = Date.now();
    let sandbox;

    this.log?.debug("Sandbox codeRun", { codeLength: code.length, timeoutSecs });

    try {
      sandbox = await this.client.create({ language: "javascript" as any });

      const response = await sandbox.process.codeRun(code, undefined, timeoutSecs);

      const durationMs = Date.now() - start;
      const exitCode = response.exitCode ?? 0;
      this.log?.debug("Sandbox codeRun completed", { exitCode, durationMs });

      return {
        exitCode,
        stdout: response.result ?? "",
        stderr: "",
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log?.error("Sandbox codeRun failed", { error: errMsg, durationMs });
      return {
        exitCode: 1,
        stdout: "",
        stderr: errMsg,
        durationMs,
      };
    } finally {
      if (sandbox) {
        try {
          await sandbox.delete();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
}
