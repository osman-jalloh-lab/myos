// One-off audit script for fix-and-harden brief 2.6 — prints the REAL health
// breakdown per category so Osman can decide item by item. Read-only.
// Run: npx tsx scripts/health-audit-report.ts

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}
loadEnvFile(path.join(process.cwd(), ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env"));

async function main() {
  const { prisma } = await import("../src/lib/db");
  const { getHealthCenterSnapshot } = await import("../src/lib/health-center");
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) { console.log("No user found."); return; }
  const snapshot = await getHealthCenterSnapshot(user.id);

  console.log(`OVERALL: ${snapshot.overall.score}% (${snapshot.overall.status}) — ${snapshot.overall.message}`);
  console.log("\n== ACCOUNTS ==");
  for (const a of snapshot.accounts) {
    console.log(`- ${a.name}: score=${a.score} connected=${a.connected} reconnect=${a.reconnectRequired} warnings=[${a.warnings.join(", ")}] lastError=${a.lastError ?? "none"}`);
  }
  console.log("\n== SCHEDULED JOBS ==");
  for (const j of snapshot.scheduledJobs) {
    console.log(`- ${j.name} (${j.key}): ${j.status} lastRun=${j.lastRun ?? "never"} ok=${j.successCount} fail=${j.failureCount} lastResult=${(j.lastResult ?? "").slice(0, 100)}`);
  }
  console.log("\n== EXECUTORS ==");
  for (const e of snapshot.executors) {
    console.log(`- ${e.name}: ${e.status} lastRun=${e.lastRun ?? "never"} lastError=${(e.lastError ?? "none").slice(0, 140)}`);
  }
  console.log("\n== NOTIFICATIONS ==");
  for (const n of snapshot.notifications) {
    console.log(`- ${n.name}: ${n.status} lastSent=${n.lastSent ?? "never"} lastFailed=${n.lastFailed ?? "never"} pending=${n.pendingNotifications}`);
  }
  console.log("\n== API PROVIDERS ==");
  for (const p of snapshot.apiProviders) {
    console.log(`- ${p.provider}: ${p.status} configured=${p.configured} error=${(p.safeError ?? "none").slice(0, 120)}`);
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
