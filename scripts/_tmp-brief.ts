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

async function main() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const res = await db.execute(`SELECT briefDate, createdAt FROM DailyBrief ORDER BY createdAt DESC LIMIT 7`);
  if (!res.rows.length) { console.log("DailyBrief table is EMPTY — cron has never persisted a brief."); return; }
  for (const r of res.rows) console.log(`brief date=${String(r.briefDate)} created=${String(r.createdAt)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1); });
