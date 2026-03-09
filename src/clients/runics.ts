import type { Env, FindSkillRequest, FindSkillResponse, SkillReference } from "../types";

export class RunicsClient {
  private baseUrl: string;
  private service?: Fetcher;

  constructor(private env: Env) {
    this.baseUrl = env.RUNICS_URL;
    this.service = env.RUNICS_SERVICE;
  }

  /**
   * Issue a fetch to Runics — uses the service binding if available
   * (avoids Cloudflare error 1042 for worker-to-worker calls on same account),
   * falls back to public URL for local dev.
   */
  private async runicsFetch(path: string, init?: RequestInit): Promise<Response> {
    if (this.service) {
      return this.service.fetch(new Request(`https://runics${path}`, init));
    }
    return fetch(`${this.baseUrl}${path}`, init);
  }

  async findSkill(request: FindSkillRequest): Promise<FindSkillResponse> {
    const res = await this.runicsFetch("/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: request.query,
        tenantId: request.tenantId,
        appetite: request.appetite ?? "balanced",
        tags: request.tags,
        category: request.category,
        limit: request.limit ?? 10,
        version: request.version,
      }),
    });

    if (!res.ok) {
      throw new Error(`Runics search failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async getSkill(slug: string, version?: string): Promise<SkillReference | null> {
    const path = version
      ? `/v1/skills/${slug}/${version}`
      : `/v1/skills/${slug}`;
    const res = await this.runicsFetch(path);

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Runics getSkill failed: ${res.status}`);
    }

    return res.json();
  }

  async recordInvocation(
    skillId: string,
    compositionId: string | null,
    tenantId: string,
    durationMs: number,
    succeeded: boolean,
  ): Promise<void> {
    await this.runicsFetch("/v1/invocations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invocations: [
          {
            skillId,
            compositionId,
            tenantId,
            callerType: "agent",
            durationMs,
            succeeded,
          },
        ],
      }),
    });
  }
}
