import { createClient } from "@libsql/client";

const c = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const r = await c.execute(
    `SELECT id, status, operationType, approvalStatus, branchName, commitSha, pullRequestUrl, errorReference, createdAt
     FROM EngineeringTask ORDER BY createdAt DESC LIMIT 8`
  );
  for (const row of r.rows) {
    console.log(JSON.stringify(row));
  }
}

main().catch(console.error);
