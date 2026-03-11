import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCogniumMessage } from "../../src/queues/cognium-consumer";
import type { Env } from "../../src/types";

function makeMockEnv(): Env {
  return {
    SESSION_CACHE: {} as KVNamespace,
    WORKFLOW_STATE: {} as KVNamespace,
    HYPERDRIVE: {} as Hyperdrive,
    R2_BUCKET: {} as R2Bucket,
    FORGE_QUEUE: { send: vi.fn() } as unknown as Queue,
    COGNIUM_QUEUE: { send: vi.fn() } as unknown as Queue,
    AI: {} as Ai,
    WORKFLOW_DO: {} as DurableObjectNamespace,
    ENVIRONMENT: "test",
    RUNICS_URL: "https://runics.test.local",
    COGNIUM_URL: "https://cognium.test.local",
    DAYTONA_TARGET: "us",
    LLM_MODEL: "cognium/claude-sonnet-latest",
    DEFAULT_EXECUTION_MODE: "review_before_run",
    DEFAULT_APPETITE: "balanced",
    WORKFLOW_TIMEOUT_MS: "300000",
    MAX_SKILL_CHAIN_DEPTH: "10",
    LLMPROXY_URL: "https://llmproxy.test.local",
    LLMPROXY_API_KEY: "test-key",
    DAYTONA_API_KEY: "test-key",
    DATABASE_URL: "postgresql://test:test@localhost/test",
  } as Env;
}

describe("Cognium Queue Consumer", () => {
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
  });

  it("should scan a skill and update trust in Runics", async () => {
    const scanResult = {
      trustScore: 0.92,
      verificationTier: "verified",
      findings: [
        {
          severity: "LOW",
          tool: "semgrep",
          title: "Minor issue",
          description: "Low severity finding",
          confidence: 0.8,
        },
      ],
      scannedAt: new Date().toISOString(),
    };

    const mockFetch = vi.fn()
      // Cognium scan API
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(scanResult),
      })
      // Runics trust update
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ updated: true }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await handleCogniumMessage(
      {
        skillId: "skill-1",
        priority: "normal",
        timestamp: Date.now(),
      },
      env,
    );

    // Should have called Cognium scan API
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const scanCall = mockFetch.mock.calls[0];
    expect(scanCall[0]).toBe("https://cognium.test.local/v1/scan");
    expect(JSON.parse(scanCall[1].body)).toEqual({ skillId: "skill-1" });

    // Should have called Runics to update trust
    const trustCall = mockFetch.mock.calls[1];
    expect(trustCall[0]).toBe("https://runics.test.local/v1/skills/skill-1/trust");
    expect(trustCall[1].method).toBe("PATCH");
    const trustBody = JSON.parse(trustCall[1].body);
    expect(trustBody.trustScore).toBe(0.92);
    expect(trustBody.verificationTier).toBe("verified");
  });

  it("should mark skill as vulnerable when critical findings exist", async () => {
    const scanResult = {
      trustScore: 0.35,
      verificationTier: "scanned",
      findings: [
        {
          severity: "CRITICAL",
          cweId: "CWE-79",
          tool: "semgrep",
          title: "XSS vulnerability",
          description: "Cross-site scripting detected",
          confidence: 0.95,
        },
        {
          severity: "HIGH",
          tool: "snyk",
          title: "Dependency vulnerability",
          description: "Outdated package with known CVE",
          confidence: 0.9,
        },
      ],
      scannedAt: new Date().toISOString(),
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(scanResult),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ updated: true }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await handleCogniumMessage(
      {
        skillId: "skill-vuln",
        priority: "high",
        timestamp: Date.now(),
      },
      env,
    );

    const trustBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(trustBody.status).toBe("vulnerable");
    expect(trustBody.remediationMessage).toContain("Critical security findings");
    expect(trustBody.remediationMessage).toContain("1 critical issue(s)");
  });

  it("should not set vulnerable status when no critical findings", async () => {
    const scanResult = {
      trustScore: 0.75,
      verificationTier: "scanned",
      findings: [
        {
          severity: "MEDIUM",
          tool: "semgrep",
          title: "Medium issue",
          description: "Some issue",
          confidence: 0.7,
        },
      ],
      scannedAt: new Date().toISOString(),
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(scanResult),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ updated: true }),
      });
    vi.stubGlobal("fetch", mockFetch);

    await handleCogniumMessage(
      {
        skillId: "skill-ok",
        priority: "normal",
        timestamp: Date.now(),
      },
      env,
    );

    const trustBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(trustBody.status).toBeUndefined();
    expect(trustBody.remediationMessage).toBeUndefined();
  });

  it("should handle scan API failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

    await handleCogniumMessage(
      {
        skillId: "skill-fail",
        priority: "normal",
        timestamp: Date.now(),
      },
      env,
    );

    // Should log error and not throw
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Scan API error"),
    );

    errorSpy.mockRestore();
  });

  it("should handle scan API network error gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Network timeout")),
    );

    await handleCogniumMessage(
      {
        skillId: "skill-timeout",
        priority: "normal",
        timestamp: Date.now(),
      },
      env,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Scan API call failed"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("should handle rescan messages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const scanResult = {
      trustScore: 0.88,
      verificationTier: "verified",
      findings: [],
      scannedAt: new Date().toISOString(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(scanResult),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ updated: true }),
        }),
    );

    await handleCogniumMessage(
      {
        skillId: "skill-rescan",
        priority: "normal",
        timestamp: Date.now(),
        rescan: true,
      },
      env,
    );

    // Should log "Re-scanning" for rescan messages
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Re-scanning"),
    );

    logSpy.mockRestore();
  });
});
