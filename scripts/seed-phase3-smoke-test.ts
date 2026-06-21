import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";

const adapter = new PrismaLibSql({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    console.error("No users found.");
    process.exit(1);
  }

  const now = new Date();

  // Re-use the branch created by Phase 2 smoke test.
  // deployPreviewBranch() requires branchName to be pre-populated.
  const branchName = "hermes/cmqn3gc3-hermes-phase-2-branch-execution-smoke-te";

  const task = await prisma.engineeringTask.create({
    data: {
      userId: user.id,
      title: "Hermes Phase 3 preview deployment smoke test",
      repositorySlug: "osman-jalloh-lab/myos",
      operationType: "preview_deployment",
      riskLevel: "low",
      approvalRequired: true,
      status: "queued",
      approvalStatus: "approved_for_preview",
      approvedAt: now,
      approvedBy: user.id,
      // Phase 2 branch — required for Phase 3 to deploy
      branchName,
      commitSha: "e28d59e186cb4d4194f8267a83e621d7dbdd3f2c",
      pullRequestUrl: "https://github.com/osman-jalloh-lab/myos/pull/1",
      deployTarget: "preview",
    },
  });

  console.log(JSON.stringify({
    taskId: task.id,
    status: task.status,
    operationType: task.operationType,
    approvalStatus: task.approvalStatus,
    branchName: task.branchName,
    repositorySlug: task.repositorySlug,
    createdAt: task.createdAt,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
