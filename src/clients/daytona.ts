import { Daytona } from "@daytonaio/sdk";
import type { Env, SandboxRequest, SandboxResult } from "../types";

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

  constructor(env: Env) {
    this.env = env;
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

      // 2. Upload the skill bundle from R2 if a bundleKey is provided
      if (request.bundleKey) {
        const obj = await this.env.R2_BUCKET.get(request.bundleKey);
        if (!obj) {
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

      return {
        exitCode: response.exitCode ?? 0,
        stdout: response.result ?? "",
        stderr: "",
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
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

    try {
      sandbox = await this.client.create({ language: "javascript" as any });

      const response = await sandbox.process.codeRun(code, undefined, timeoutSecs);

      return {
        exitCode: response.exitCode ?? 0,
        stdout: response.result ?? "",
        stderr: "",
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
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
