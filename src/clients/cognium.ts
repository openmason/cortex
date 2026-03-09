import type {
  Env,
  SkillReference,
  TrustCheckResult,
  CogniumSeverity,
  Appetite,
} from "../types";

/**
 * Cognium Client — trust scoring and security checks.
 *
 * Cortex calls Cognium to:
 * 1. Pre-flight check: Is this skill safe to execute at the tenant's appetite?
 * 2. Runtime warning: Should the agent surface a warning about this skill?
 * 3. Block decision: Is this skill revoked/blocked?
 */
export class CogniumClient {
  constructor(private env: Env) {}

  /**
   * Pre-flight trust check before executing a skill.
   * Returns whether the skill should be blocked, warned, or allowed.
   */
  checkTrust(skill: SkillReference, appetite: Appetite): TrustCheckResult {
    const threshold = appetiteToTrustThreshold(appetite);

    // Hard block: revoked skills
    if (skill.status === "revoked") {
      return {
        skillId: skill.id,
        trustScore: skill.trustScore,
        verificationTier: skill.verificationTier,
        severity: "CRITICAL",
        findings: [],
        blocked: true,
        warning: buildRevocationMessage(skill),
      };
    }

    // Hard block: degraded composites (contain revoked constituent)
    if (skill.status === "degraded") {
      return {
        skillId: skill.id,
        trustScore: skill.trustScore,
        verificationTier: skill.verificationTier,
        severity: "CRITICAL",
        findings: [],
        blocked: true,
        warning: `Composite skill ${skill.slug} is degraded — one or more constituent skills have been revoked.`,
      };
    }

    // Trust floor block
    if (skill.trustScore < threshold) {
      return {
        skillId: skill.id,
        trustScore: skill.trustScore,
        verificationTier: skill.verificationTier,
        findings: [],
        blocked: true,
        warning: `Skill ${skill.slug} trust score (${skill.trustScore}) is below appetite threshold (${threshold}).`,
      };
    }

    // Warning: vulnerable skills
    if (skill.status === "vulnerable" || skill.status === "contains-vulnerable") {
      return {
        skillId: skill.id,
        trustScore: skill.trustScore,
        verificationTier: skill.verificationTier,
        severity: "HIGH",
        findings: [],
        blocked: false,
        warning: `Skill ${skill.slug} has known vulnerabilities. ${skill.remediationMessage ?? ""}`,
      };
    }

    // All clear
    return {
      skillId: skill.id,
      trustScore: skill.trustScore,
      verificationTier: skill.verificationTier,
      findings: [],
      blocked: false,
    };
  }

  /**
   * Submit a skill for async Cognium scanning (via queue).
   */
  async submitForScan(skillId: string, priority: "high" | "normal" = "normal"): Promise<void> {
    await this.env.COGNIUM_QUEUE.send({
      skillId,
      priority,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function appetiteToTrustThreshold(appetite: Appetite): number {
  switch (appetite) {
    case "strict":
      return 0.85;
    case "cautious":
      return 0.7;
    case "balanced":
      return 0.5;
    case "adventurous":
      return 0.2;
  }
}

function buildRevocationMessage(skill: SkillReference): string {
  const lines = [`Skill ${skill.slug}@${skill.version} was revoked.`];

  if (skill.revokedReason) {
    lines.push(`Reason: ${skill.revokedReason}`);
  }
  if (skill.remediationMessage) {
    lines.push(`\n${skill.remediationMessage}`);
  }
  if (skill.remediationUrl) {
    lines.push(`Advisory: ${skill.remediationUrl}`);
  }

  return lines.join("\n");
}
