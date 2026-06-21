import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ALTERS = [
  // Phase 2 — branch execution
  `ALTER TABLE "EngineeringTask" ADD COLUMN "approvalStatus" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "approvedAt" DATETIME`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "approvedBy" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "branchName" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "commitSha" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "pullRequestUrl" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "implementationSummary" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "validationResults" TEXT`,
  // Phase 3 — deployment
  `ALTER TABLE "EngineeringTask" ADD COLUMN "deployTarget" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "deployStatus" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "vercelDeploymentId" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "deploymentUrl" TEXT`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "deployStartedAt" DATETIME`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "deployCompletedAt" DATETIME`,
  `ALTER TABLE "EngineeringTask" ADD COLUMN "rollbackReference" TEXT`,
];

async function main() {
  for (const sql of ALTERS) {
    const col = sql.match(/"(\w+)"\s*\w+$/)?.[1] ?? sql;
    try {
      await client.execute(sql);
      console.log(`  added: ${col}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column")) {
        console.log(`  skip (exists): ${col}`);
      } else {
        console.error(`  ERROR on ${col}: ${msg}`);
        process.exit(1);
      }
    }
  }
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
