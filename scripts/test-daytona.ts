/**
 * Quick smoke test for Daytona SDK integration.
 *
 * Usage:
 *   DAYTONA_API_KEY=your-key npx tsx scripts/test-daytona.ts
 */
import { Daytona } from "@daytonaio/sdk";

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("Set DAYTONA_API_KEY env var first");
  process.exit(1);
}

async function main() {
  console.log("1. Connecting to Daytona...");
  const daytona = new Daytona({ apiKey, apiUrl: "https://app.daytona.io/api", target: "us" });

  console.log("2. Creating sandbox...");
  const sandbox = await daytona.create({ language: "typescript" });
  console.log("   Sandbox created.");

  console.log("3. Running command...");
  const res = await sandbox.process.executeCommand('echo "Hello from Daytona sandbox"');
  console.log("   Exit code:", res.exitCode);
  console.log("   Output:", res.result);

  console.log("4. Running Node script...");
  const res2 = await sandbox.process.executeCommand(
    'node -e "console.log(JSON.stringify({ ts: Date.now(), platform: process.platform, arch: process.arch }))"',
  );
  console.log("   Exit code:", res2.exitCode);
  console.log("   Output:", res2.result);

  console.log("5. Cleaning up...");
  await sandbox.delete();
  console.log("   Done.");
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
