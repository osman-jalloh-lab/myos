import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const builds = await prisma.engineeringTask.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      status: true,
      operationType: true,
      riskLevel: true,
      approvalStatus: true,
      approvalRequired: true,
      resultSummary: true,
      implementationSummary: true,
      branchName: true,
      pullRequestUrl: true,
      deploymentUrl: true,
      deployStatus: true,
      sanitizedError: true,
      startedAt: true,
      completedAt: true,
      deployStartedAt: true,
      deployCompletedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ builds });
}
