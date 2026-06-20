import { prisma } from "../src/lib/db";

async function main() {
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        primaryEmail: "osman@localhost",
        name: "osman",
      },
    });
    console.log(`Created User ${user.id}`);
  }

  const task = await prisma.engineeringTask.create({
    data: {
      userId: user.id,
      title: "Read-only Parawi repository inspection",
      repositorySlug: "osman-jalloh-lab/parawi",
      operationType: "read_only_repo_inspection",
      riskLevel: "low",
      approvalRequired: false,
      status: "queued",
    },
  });

  console.log("Created EngineeringTask", task.id);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
