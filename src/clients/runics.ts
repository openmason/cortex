import type {
  Env,
  FindSkillRequest,
  FindSkillResponse,
  SkillReference,
  ListCompositesResponse,
  CompositeSkillDetail,
  UpdateCompositeRequest,
  ForkCompositeRequest,
  ForkCompositeResponse,
} from "../types";

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
        userId: request.userId,
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

  // ---------------------------------------------------------------------------
  // Composite Skill Management
  // ---------------------------------------------------------------------------

  async listComposites(
    tenantId: string,
    options?: { status?: string; limit?: number; offset?: number; userId?: string },
  ): Promise<ListCompositesResponse> {
    const params = new URLSearchParams({
      tenantId,
      skillType: "human-composite,auto-composite,forked",
    });
    if (options?.userId) params.set("userId", options.userId);
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));

    const res = await this.runicsFetch(`/v1/skills?${params.toString()}`);

    if (!res.ok) {
      throw new Error(`Runics listComposites failed: ${res.status}`);
    }

    return res.json();
  }

  async getCompositeDetail(slug: string, version?: string): Promise<CompositeSkillDetail | null> {
    const path = version
      ? `/v1/skills/${slug}/${version}?include=steps`
      : `/v1/skills/${slug}?include=steps`;
    const res = await this.runicsFetch(path);

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Runics getCompositeDetail failed: ${res.status}`);
    }

    return res.json();
  }

  async updateComposite(
    slug: string,
    tenantId: string,
    updates: UpdateCompositeRequest,
  ): Promise<CompositeSkillDetail> {
    const res = await this.runicsFetch(`/v1/skills/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, tenantId }),
    });

    if (res.status === 404) {
      throw new Error("Composite skill not found");
    }
    if (res.status === 403) {
      throw new Error("Unauthorized: only the owning tenant can update this skill");
    }
    if (!res.ok) {
      throw new Error(`Runics updateComposite failed: ${res.status}`);
    }

    return res.json();
  }

  async deprecateComposite(
    slug: string,
    tenantId: string,
    reason?: string,
    replacementSkillSlug?: string,
  ): Promise<{ slug: string; status: string }> {
    const res = await this.runicsFetch(`/v1/skills/${slug}/deprecate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, reason, replacementSkillSlug }),
    });

    if (res.status === 404) {
      throw new Error("Composite skill not found");
    }
    if (res.status === 403) {
      throw new Error("Unauthorized: only the owning tenant can deprecate this skill");
    }
    if (!res.ok) {
      throw new Error(`Runics deprecateComposite failed: ${res.status}`);
    }

    return res.json();
  }

  async forkComposite(
    slug: string,
    tenantId: string,
    userId: string,
    request: ForkCompositeRequest,
  ): Promise<ForkCompositeResponse> {
    const res = await this.runicsFetch(`/v1/skills/${slug}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, tenantId, forkedBy: userId }),
    });

    if (res.status === 404) {
      throw new Error("Composite skill not found");
    }
    if (!res.ok) {
      throw new Error(`Runics forkComposite failed: ${res.status}`);
    }

    return res.json();
  }
}
