import { describe, it, expect } from "vitest";
import { getProductConfig, PRODUCT_CONFIGS } from "../../src/agents/product-configs";

describe("Product Configs", () => {
  describe("getProductConfig", () => {
    it("should return bombastic config", () => {
      const config = getProductConfig("bombastic");
      expect(config.product).toBe("bombastic");
      expect(config.defaultMode).toBe("full_auto");
      expect(config.enablePolicyEngine).toBe(false);
      expect(config.enableHumanReview).toBe(false);
      expect(config.defaultAppetite).toBe("balanced");
    });

    it("should return costaff config", () => {
      const config = getProductConfig("costaff");
      expect(config.product).toBe("costaff");
      expect(config.defaultMode).toBe("review_before_run");
      expect(config.enablePolicyEngine).toBe(true);
      expect(config.enableHumanReview).toBe(true);
      expect(config.defaultAppetite).toBe("cautious");
      expect(config.trustFloor).toBe(0.7);
    });

    it("should return controlcenter config", () => {
      const config = getProductConfig("controlcenter");
      expect(config.product).toBe("controlcenter");
      expect(config.defaultMode).toBe("review_before_run");
      expect(config.enablePolicyEngine).toBe(true);
      expect(config.enableHumanReview).toBe(true);
      expect(config.systemPrompt).toContain("human approval");
    });

    it("should throw for unknown product", () => {
      expect(() => getProductConfig("unknown")).toThrow("Unknown product");
    });
  });

  describe("Product differentiation", () => {
    it("bombastic should be most permissive (full_auto, no policy, no review)", () => {
      const config = PRODUCT_CONFIGS.bombastic;
      expect(config.defaultMode).toBe("full_auto");
      expect(config.enablePolicyEngine).toBe(false);
      expect(config.enableHumanReview).toBe(false);
      expect(config.trustFloor).toBe(0.5);
    });

    it("costaff should be cautious (review, policy, higher trust floor)", () => {
      const config = PRODUCT_CONFIGS.costaff;
      expect(config.trustFloor).toBeGreaterThan(PRODUCT_CONFIGS.bombastic.trustFloor);
      expect(config.enablePolicyEngine).toBe(true);
    });

    it("controlcenter should have human review and save-as-skill capability", () => {
      const config = PRODUCT_CONFIGS.controlcenter;
      expect(config.enableHumanReview).toBe(true);
      expect(config.systemPrompt).toContain("saveAsSkill");
    });

    it("all products should have system prompts with findSkill tool", () => {
      for (const key of Object.keys(PRODUCT_CONFIGS)) {
        expect(PRODUCT_CONFIGS[key].systemPrompt).toContain("findSkill");
      }
    });
  });
});
