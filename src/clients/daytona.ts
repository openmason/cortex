import type { Env, SandboxRequest, SandboxResult } from "../types";

export class DaytonaClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(private env: Env) {
    this.baseUrl = env.DAYTONA_URL;
    this.apiKey = env.DAYTONA_API_KEY;
  }

  async createSandbox(request: SandboxRequest): Promise<SandboxResult> {
    const start = Date.now();

    // Fetch the bundle from R2 if needed
    let bundleUrl: string | undefined;
    if (request.bundleKey) {
      const obj = await this.env.R2_BUCKET.get(request.bundleKey);
      if (!obj) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Bundle not found: ${request.bundleKey}`,
          durationMs: Date.now() - start,
        };
      }
      // In production, generate a presigned URL for Daytona to fetch
      bundleUrl = `r2://${request.bundleKey}`;
    }

    const res = await fetch(`${this.baseUrl}/v1/sandboxes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        image: "ubuntu:22.04",
        command: request.command,
        env: request.env ?? {},
        bundleUrl,
        timeoutMs: request.timeoutMs ?? 60_000,
      }),
    });

    if (!res.ok) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Daytona API error: ${res.status} ${await res.text()}`,
        durationMs: Date.now() - start,
      };
    }

    const result: { exitCode: number; stdout: string; stderr: string } = await res.json();

    return {
      ...result,
      durationMs: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }
}
