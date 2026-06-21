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
    console.error("No users found in database.");
    process.exit(1);
  }
  console.log(`Using user: ${user.id} (${user.primaryEmail ?? "no email"})`);

  const task = await prisma.engineeringTask.create({
    data: {
      userId: user.id,
      title: "Read-only inspection of osman-jalloh-lab/parawi",
      repositorySlug: "osman-jalloh-lab/parawi",
      operationType: "read_only_repo_inspection",
      riskLevel: "low",
      approvalRequired: false,
      status: "queued",
      correlationId: null,
      executorName: null,
      executorJobId: null,
      resultSummary: null,
      errorReference: null,
      sanitizedError: null,
    },
  });

  console.log(JSON.stringify({ taskId: task.id, status: task.status, createdAt: task.createdAt }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
