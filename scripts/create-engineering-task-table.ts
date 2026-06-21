import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS "EngineeringTask" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "userId"           TEXT NOT NULL,
  "title"            TEXT NOT NULL,
  "repositorySlug"   TEXT NOT NULL,
  "operationType"    TEXT NOT NULL,
  "riskLevel"        TEXT NOT NULL,
  "approvalRequired" INTEGER NOT NULL DEFAULT 0,
  "status"           TEXT NOT NULL DEFAULT 'queued',
  "correlationId"    TEXT,
  "executorName"     TEXT,
  "executorJobId"    TEXT,
  "resultSummary"    TEXT,
  "errorReference"   TEXT,
  "sanitizedError"   TEXT,
  "startedAt"        DATETIME,
  "completedAt"      DATETIME,
  "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngineeringTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`.trim();

const CREATE_IDX_1 = `CREATE INDEX IF NOT EXISTS "EngineeringTask_userId_status_idx" ON "EngineeringTask"("userId", "status");`;
const CREATE_IDX_2 = `CREATE INDEX IF NOT EXISTS "EngineeringTask_userId_createdAt_idx" ON "EngineeringTask"("userId", "createdAt");`;

async function main() {
  console.log("Creating EngineeringTask table...");
  await client.execute(CREATE_TABLE);
  await client.execute(CREATE_IDX_1);
  await client.execute(CREATE_IDX_2);
  console.log("Table and indexes created (or already exist).");

  // Verify by listing tables
  const result = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='EngineeringTask';`
  );
  if (result.rows.length > 0) {
    console.log("Verified: EngineeringTask table exists.");
  } else {
    console.error("Table creation failed — table not found after CREATE.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
