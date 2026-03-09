import type { Env } from "../types";

/**
 * Cognium Queue Consumer — processes async trust scanning jobs.
 *
 * Message types:
 *
 *   scan     — Run a full security scan on a skill bundle. The scan calls
 *              the Cognium API which runs static analysis, dependency audit,
 *              and vulnerability checks. Results are posted back to Runics
 *              to update the skill's trust score and verification tier.
 *
 *   rescan   — Re-scan a previously scanned skill (e.g. after a new CVE
 *              disclosure or dependency update).
 */

interface ScanPayload {
  skillId: string;
  priority: "high" | "normal";
  timestamp: number;
  rescan?: boolean;
}

export async function handleCogniumMessage(
  payload: ScanPayload,
  env: Env,
): Promise<void> {
  console.log(
    `[cognium] ${payload.rescan ? "Re-scanning" : "Scanning"} skill: ${payload.skillId} (priority: ${payload.priority})`,
  );

  // Call the Cognium scanning API
  const scanResult = await requestScan(payload.skillId, env);

  if (!scanResult) {
    console.error(`[cognium] Scan failed for skill: ${payload.skillId}`);
    return;
  }

  // Post the scan results back to Runics to update the skill's trust metadata
  await updateSkillTrust(payload.skillId, scanResult, env);

  console.log(
    `[cognium] Scan complete for ${payload.skillId}: ` +
    `score=${scanResult.trustScore}, tier=${scanResult.verificationTier}, ` +
    `findings=${scanResult.findings.length}`,
  );
}

// ---------------------------------------------------------------------------
// Cognium API interaction
// ---------------------------------------------------------------------------

interface ScanResult {
  trustScore: number;
  verificationTier: "unverified" | "scanned" | "verified" | "certified";
  findings: Array<{
    severity: string;
    cweId?: string;
    tool: string;
    title: string;
    description: string;
    confidence: number;
  }>;
  scannedAt: string;
}

async function requestScan(
  skillId: string,
  env: Env,
): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${env.COGNIUM_URL}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId }),
    });

    if (!res.ok) {
      console.error(`[cognium] Scan API error: ${res.status} ${await res.text()}`);
      return null;
    }

    return res.json();
  } catch (err) {
    console.error(`[cognium] Scan API call failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update skill trust in Runics
// ---------------------------------------------------------------------------

async function updateSkillTrust(
  skillId: string,
  scanResult: ScanResult,
  env: Env,
): Promise<void> {
  try {
    // Determine if any findings warrant status changes
    const hasCritical = scanResult.findings.some((f) => f.severity === "CRITICAL");
    const hasHigh = scanResult.findings.some((f) => f.severity === "HIGH");

    const statusUpdate: Record<string, unknown> = {
      trustScore: scanResult.trustScore,
      verificationTier: scanResult.verificationTier,
      lastScannedAt: scanResult.scannedAt,
      findings: scanResult.findings,
    };

    // Critical findings → mark as vulnerable
    if (hasCritical) {
      statusUpdate.status = "vulnerable";
      statusUpdate.remediationMessage =
        `Critical security findings detected. ${scanResult.findings.filter((f) => f.severity === "CRITICAL").length} critical issue(s) found.`;
    }

    const res = await fetch(`${env.RUNICS_URL}/v1/skills/${skillId}/trust`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statusUpdate),
    });

    if (!res.ok) {
      console.error(`[cognium] Failed to update trust for ${skillId}: ${res.status}`);
    }
  } catch (err) {
    console.error(`[cognium] Trust update failed for ${skillId}:`, err);
  }
}
