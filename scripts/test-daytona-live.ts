/**
 * Spins up a live web server in a Daytona sandbox you can visit in the browser.
 *
 * Usage:
 *   DAYTONA_API_KEY=your-key npx tsx scripts/test-daytona-live.ts
 */
import { Daytona } from "@daytonaio/sdk";

const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) {
  console.error("Set DAYTONA_API_KEY env var first");
  process.exit(1);
}

async function main() {
  const daytona = new Daytona({
    apiKey,
    apiUrl: "https://app.daytona.io/api",
    target: "us",
  });

  console.log("Creating sandbox...");
  const sandbox = await daytona.create({ language: "typescript" });
  console.log("Sandbox ready.");

  const serverCode = `
const http = require("http");
const os = require("os");
const server = http.createServer((req, res) => {
  const info = {
    hostname: os.hostname(),
    platform: os.platform() + " / " + os.arch(),
    cpus: os.cpus().length,
    memory: Math.round(os.freemem()/1024/1024) + "MB free / " + Math.round(os.totalmem()/1024/1024) + "MB total",
    uptime: Math.round(os.uptime()) + "s",
    timestamp: new Date().toISOString(),
    path: req.url,
  };
  res.writeHead(200, {"Content-Type":"text/html"});
  res.end(\`<!DOCTYPE html><html><head><title>Cortex Sandbox</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e0e0e0;display:flex;justify-content:center;padding:40px}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;max-width:520px;width:100%}
h1{color:#60a5fa;margin:0 0 8px;font-size:20px}p.sub{color:#888;margin:0 0 24px;font-size:14px}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #222;font-size:14px}
td:first-child{color:#888;width:120px}td:last-child{color:#e0e0e0;font-family:monospace}
.badge{display:inline-block;background:#1e3a1e;color:#4ade80;padding:2px 8px;border-radius:4px;font-size:12px}</style></head>
<body><div class="card"><h1>Cortex L3 Sandbox</h1>
<p class="sub">Running live inside a Daytona container <span class="badge">online</span></p>
<table>
<tr><td>Hostname</td><td>\${info.hostname}</td></tr>
<tr><td>Platform</td><td>\${info.platform}</td></tr>
<tr><td>CPUs</td><td>\${info.cpus}</td></tr>
<tr><td>Memory</td><td>\${info.memory}</td></tr>
<tr><td>Uptime</td><td>\${info.uptime}</td></tr>
<tr><td>Timestamp</td><td>\${info.timestamp}</td></tr>
<tr><td>Request</td><td>\${info.path}</td></tr>
</table></div></body></html>\`);
});
server.listen(3000, () => console.log("OK"));
`;

  console.log("Writing server code...");
  await sandbox.process.executeCommand(
    `cat > /workspace/server.js << 'ENDOFSCRIPT'\n${serverCode}\nENDOFSCRIPT`,
  );

  console.log("Starting web server...");
  await sandbox.process.createSession("srv");
  await sandbox.process.executeSessionCommand("srv", {
    command: "node /workspace/server.js",
    runAsync: true,
  });

  // Wait for server to be ready
  await new Promise((r) => setTimeout(r, 3000));

  // Verify server is responding inside the sandbox
  const check = await sandbox.process.executeCommand("curl -s -o /dev/null -w '%{http_code}' http://localhost:3000");
  console.log("Health check:", check.result?.trim());

  const preview = await sandbox.getPreviewLink(3000);
  console.log("\n========================================");
  console.log("  LIVE URL:");
  console.log(`  ${preview.url}`);
  console.log("========================================");
  console.log("\nSandbox will stay alive. Press Ctrl+C to destroy.\n");

  // Keep alive with periodic heartbeat
  const interval = setInterval(async () => {
    try {
      await sandbox.process.executeCommand("echo heartbeat");
    } catch {
      clearInterval(interval);
    }
  }, 30_000);

  process.on("SIGINT", async () => {
    clearInterval(interval);
    console.log("\nDestroying sandbox...");
    await sandbox.delete();
    console.log("Done.");
    process.exit(0);
  });

  // Keep process alive indefinitely
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
