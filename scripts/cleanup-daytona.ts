import { Daytona } from "@daytonaio/sdk";

async function main() {
  const d = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    apiUrl: "https://app.daytona.io/api",
    target: "us",
  });
  const result = await d.list();
  const sandboxes = result.items ?? [];
  console.log(`Found ${sandboxes.length} sandbox(es)`);
  for (const s of sandboxes) {
    console.log(`Deleting ${s.id}...`);
    await s.delete();
  }
  console.log("All cleaned up.");
}

main().catch((e) => { console.error(e); process.exit(1); });
