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
  console.log(`Using user: ${user.id} (${user.primaryEmail ?? "no email"})`);

  const now = new Date();

  const task = await prisma.engineeringTask.create({
    data: {
      userId: user.id,
      title: "Hermes Phase 2 branch execution smoke test",
      repositorySlug: "osman-jalloh-lab/myos",
      operationType: "repo_code_change",
      riskLevel: "low",
      approvalRequired: true,
      status: "queued",
      // Approval pre-persisted — required before executor may claim this task
      approvalStatus: "approved_for_implementation",
      approvedAt: now,
      approvedBy: user.id,
      correlationId: null,
      executorName: null,
      executorJobId: null,
      resultSummary: null,
      errorReference: null,
      sanitizedError: null,
      branchName: null,
      commitSha: null,
      pullRequestUrl: null,
      implementationSummary: null,
      validationResults: null,
      deployTarget: null,
      deployStatus: null,
      vercelDeploymentId: null,
      deploymentUrl: null,
      deployStartedAt: null,
      deployCompletedAt: null,
      rollbackReference: null,
    },
  });

  console.log(JSON.stringify(
    {
      taskId: task.id,
      status: task.status,
      approvalStatus: task.approvalStatus,
      approvedAt: task.approvedAt,
      approvedBy: task.approvedBy,
      createdAt: task.createdAt,
    },
    null,
    2
  ));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
