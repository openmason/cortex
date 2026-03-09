import { describe, it, expect, vi } from "vitest";
import { CogniumClient, appetiteToTrustThreshold } from "../../src/clients/cognium";
import type { Env, SkillReference } from "../../src/types";

function makeSkill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    id: "skill-1",
    slug: "test-skill",
    version: "1.0.0",
    name: "Test Skill",
    executionLayer: "worker",
    trustScore: 0.85,
    verificationTier: "verified",
    trustBadge: null,
    status: "published",
    skillType: "atomic",
    runCount: 10,
    ...overrides,
  };
}

const mockEnv = {
  COGNIUM_QUEUE: { send: vi.fn() },
} as unknown as Env;

describe("CogniumClient", () => {
  const client = new CogniumClient(mockEnv);

  describe("checkTrust", () => {
    it("should allow published skills above trust threshold", () => {
      const skill = makeSkill({ trustScore: 0.85, status: "published" });
      const result = client.checkTrust(skill, "balanced");

      expect(result.blocked).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it("should block revoked skills", () => {
      const skill = makeSkill({
        status: "revoked",
        revokedReason: "RUSTSEC-2024-XXXX",
        remediationMessage: "Upgrade to v1.2.0",
      });
      const result = client.checkTrust(skill, "balanced");

      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("CRITICAL");
      expect(result.warning).toContain("revoked");
      expect(result.warning).toContain("RUSTSEC-2024-XXXX");
    });

    it("should block degraded composites", () => {
      const skill = makeSkill({ status: "degraded", skillType: "human-composite" });
      const result = client.checkTrust(skill, "balanced");

      expect(result.blocked).toBe(true);
      expect(result.severity).toBe("CRITICAL");
      expect(result.warning).toContain("degraded");
    });

    it("should block skills below trust threshold", () => {
      const skill = makeSkill({ trustScore: 0.3, status: "published" });
      const result = client.checkTrust(skill, "balanced"); // threshold = 0.50

      expect(result.blocked).toBe(true);
      expect(result.warning).toContain("below appetite threshold");
    });

    it("should warn about vulnerable skills without blocking", () => {
      const skill = makeSkill({
        trustScore: 0.75,
        status: "vulnerable",
        remediationMessage: "Known issue in dependency X",
      });
      const result = client.checkTrust(skill, "balanced");

      expect(result.blocked).toBe(false);
      expect(result.severity).toBe("HIGH");
      expect(result.warning).toContain("vulnerabilities");
    });

    it("should warn about contains-vulnerable composites", () => {
      const skill = makeSkill({
        trustScore: 0.8,
        status: "contains-vulnerable",
        skillType: "human-composite",
      });
      const result = client.checkTrust(skill, "balanced");

      expect(result.blocked).toBe(false);
      expect(result.warning).toContain("vulnerabilities");
    });

    it("should respect strict appetite (higher threshold)", () => {
      const skill = makeSkill({ trustScore: 0.80, status: "published" });

      const strictResult = client.checkTrust(skill, "strict"); // threshold = 0.85
      expect(strictResult.blocked).toBe(true);

      const balancedResult = client.checkTrust(skill, "balanced"); // threshold = 0.50
      expect(balancedResult.blocked).toBe(false);
    });

    it("should respect adventurous appetite (lower threshold)", () => {
      const skill = makeSkill({ trustScore: 0.25, status: "published" });

      const adventurousResult = client.checkTrust(skill, "adventurous"); // threshold = 0.20
      expect(adventurousResult.blocked).toBe(false);

      const cautiousResult = client.checkTrust(skill, "cautious"); // threshold = 0.70
      expect(cautiousResult.blocked).toBe(true);
    });
  });

  describe("submitForScan", () => {
    it("should enqueue a scan request", async () => {
      await client.submitForScan("skill-1", "high");

      expect(mockEnv.COGNIUM_QUEUE.send).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: "skill-1",
          priority: "high",
        }),
      );
    });
  });
});

describe("appetiteToTrustThreshold", () => {
  it("should return correct thresholds", () => {
    expect(appetiteToTrustThreshold("strict")).toBe(0.85);
    expect(appetiteToTrustThreshold("cautious")).toBe(0.70);
    expect(appetiteToTrustThreshold("balanced")).toBe(0.50);
    expect(appetiteToTrustThreshold("adventurous")).toBe(0.20);
  });
});
