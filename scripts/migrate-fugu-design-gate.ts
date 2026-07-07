/**
 * Adds Fugu Design Gate metadata columns to existing Hermes Project rows.
 *
 * Usage: npx tsx scripts/migrate-fugu-design-gate.ts
 */
import { createClient } from "@libsql/client";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const columns = [
  `ALTER TABLE Project ADD COLUMN fuguGateStatus TEXT`,
  `ALTER TABLE Project ADD COLUMN fuguGateScore INTEGER`,
  `ALTER TABLE Project ADD COLUMN fuguGateReview TEXT`,
  `ALTER TABLE Project ADD COLUMN fuguGateReviewedAt TEXT`,
  `ALTER TABLE Project ADD COLUMN fuguGateOverrideReason TEXT`,
  `ALTER TABLE Project ADD COLUMN fuguPolishStatus TEXT`,
];

async function main() {
  console.log("Applying Fugu Design Gate migration...");
  for (const sql of columns) {
    await db.execute(sql).catch(() => undefined);
  }
  console.log("Fugu Design Gate migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
