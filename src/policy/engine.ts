import type {
  Env,
  SkillReference,
  TenantContext,
  WorkflowPlan,
} from "../types";
import { WorkflowRepository } from "../db/repository";

/**
 * Policy Engine — CoStaff / ControlCenter policy enforcement.
 *
 * Checks tenant policies before skill execution:
 * - Category sensitivity: require approval for sensitive categories
 * - Blocked skill slugs: hard block specific skills per tenant
 * - Trust floor enforcement: per-tenant minimum trust override
 * - Concurrent workflow limits
 */

export interface TenantPolicy {
  tenantId: string;
  product: string;
  defaultMode: string;
  defaultAppetite: string;
  trustFloor: number;
  enableHumanReview: boolean;
  sensitiveCategories: string[];
  blockedSkillSlugs: string[];
  maxConcurrentWorkflows: number;
}

export interface PolicyCheckResult {
  allowed: boolean;
  requiresReview: boolean;
  violations: PolicyViolation[];
}

export interface PolicyViolation {
  type: "blocked_skill" | "sensitive_category" | "trust_floor" | "concurrent_limit";
  message: string;
  skillSlug?: string;
  category?: string;
}

const POLICY_CACHE_TTL = 300; // 5 minutes

export class PolicyEngine {
  constructor(private env: Env) {}

  /**
   * Load a tenant policy using the chain: KV cache → DB → defaultPolicy().
   * Caches to KV with a 5-minute TTL on DB hits.
   */
  async loadPolicy(tenantId: string, product: string): Promise<TenantPolicy> {
    const cacheKey = `policy:${tenantId}:${product}`;

    // 1. KV cache
    try {
      const cached = await this.env.SESSION_CACHE.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Cache miss or parse error — continue
    }

    // 2. DB lookup
    try {
      const repo = new WorkflowRepository(this.env);
      const dbPolicy = await repo.loadPolicy(tenantId, product);
      if (dbPolicy) {
        // Cache the result
        try {
          await this.env.SESSION_CACHE.put(cacheKey, JSON.stringify(dbPolicy), {
            expirationTtl: POLICY_CACHE_TTL,
          });
        } catch {
          // Non-critical — continue without caching
        }
        return dbPolicy;
      }
    } catch {
      // DB error — fall through to default
    }

    // 3. Default
    return defaultPolicy(tenantId, product);
  }

  /**
   * Check a full workflow plan against tenant policies.
   */
  async checkPlan(
    plan: WorkflowPlan,
    tenant: TenantContext,
    policy: TenantPolicy,
  ): Promise<PolicyCheckResult> {
    const violations: PolicyViolation[] = [];
    let requiresReview = false;

    for (const step of plan.steps) {
      const stepResult = this.checkSkill(step.skill, policy);
      violations.push(...stepResult.violations);

      if (stepResult.requiresReview) {
        requiresReview = true;
      }
    }

    const blocked = violations.some(
      (v) => v.type === "blocked_skill" || v.type === "concurrent_limit",
    );

    return {
      allowed: !blocked,
      requiresReview: requiresReview || violations.length > 0,
      violations,
    };
  }

  /**
   * Check a single skill against tenant policies.
   */
  checkSkill(
    skill: SkillReference,
    policy: TenantPolicy,
  ): PolicyCheckResult {
    const violations: PolicyViolation[] = [];
    let requiresReview = false;

    // Check blocked skill slugs
    if (policy.blockedSkillSlugs.includes(skill.slug)) {
      violations.push({
        type: "blocked_skill",
        message: `Skill "${skill.slug}" is blocked by tenant policy`,
        skillSlug: skill.slug,
      });
    }

    // Check sensitive categories — require human review
    if (skill.capabilitiesRequired) {
      for (const cap of skill.capabilitiesRequired) {
        if (policy.sensitiveCategories.includes(cap)) {
          requiresReview = true;
          violations.push({
            type: "sensitive_category",
            message: `Skill "${skill.slug}" requires capability "${cap}" which is marked sensitive`,
            skillSlug: skill.slug,
            category: cap,
          });
        }
      }
    }

    // Check trust floor
    if (skill.trustScore < policy.trustFloor) {
      violations.push({
        type: "trust_floor",
        message: `Skill "${skill.slug}" trust (${skill.trustScore}) is below tenant floor (${policy.trustFloor})`,
        skillSlug: skill.slug,
      });
    }

    const blocked = violations.some((v) => v.type === "blocked_skill");

    return {
      allowed: !blocked,
      requiresReview,
      violations,
    };
  }

  /**
   * Check concurrent workflow limit for a tenant.
   */
  async checkConcurrentLimit(
    tenantId: string,
    policy: TenantPolicy,
  ): Promise<PolicyViolation | null> {
    // Read active workflow count from KV
    const countStr = await this.env.WORKFLOW_STATE.get(
      `tenant_active_workflows:${tenantId}`,
    );
    const activeCount = countStr ? parseInt(countStr, 10) : 0;

    if (activeCount >= policy.maxConcurrentWorkflows) {
      return {
        type: "concurrent_limit",
        message: `Tenant has ${activeCount} active workflows (max: ${policy.maxConcurrentWorkflows})`,
      };
    }

    return null;
  }

  /**
   * Increment / decrement active workflow counter.
   */
  async trackWorkflowStart(tenantId: string): Promise<void> {
    try {
      const key = `tenant_active_workflows:${tenantId}`;
      const countStr = await this.env.WORKFLOW_STATE.get(key);
      const count = countStr ? parseInt(countStr, 10) : 0;
      await this.env.WORKFLOW_STATE.put(key, String(count + 1), {
        expirationTtl: 86400,
      });
    } catch {
      // Best-effort — KV daily write limit may be exceeded
    }
  }

  async trackWorkflowEnd(tenantId: string): Promise<void> {
    try {
      const key = `tenant_active_workflows:${tenantId}`;
      const countStr = await this.env.WORKFLOW_STATE.get(key);
      const count = countStr ? parseInt(countStr, 10) : 0;
      await this.env.WORKFLOW_STATE.put(key, String(Math.max(0, count - 1)), {
        expirationTtl: 86400,
      });
    } catch {
      // Best-effort — KV daily write limit may be exceeded
    }
  }
}

/**
 * Default policy for tenants without custom configuration.
 */
export function defaultPolicy(tenantId: string, product: string): TenantPolicy {
  return {
    tenantId,
    product,
    defaultMode: product === "bombastic" ? "full_auto" : "review_before_run",
    defaultAppetite: product === "costaff" ? "cautious" : "balanced",
    trustFloor: product === "costaff" ? 0.7 : 0.5,
    enableHumanReview: product !== "bombastic",
    sensitiveCategories: product === "costaff"
      ? ["filesystem", "git", "browser", "docker", "binary"]
      : [],
    blockedSkillSlugs: [],
    maxConcurrentWorkflows: 10,
  };
}
