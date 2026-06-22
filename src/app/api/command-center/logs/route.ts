import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  const limit = Math.min(parseInt(new URL(req.url).searchParams.get("limit") ?? "40"), 100);

  const [runs, audit] = await Promise.all([
    prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        agentName: true,
        inputSummary: true,
        outputSummary: true,
        modelProvider: true,
        status: true,
        createdAt: true,
      },
    }).catch(() => [] as never[]),
    prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        detail: true,
        createdAt: true,
      },
    }).catch(() => [] as never[]),
  ]);

  return NextResponse.json({ runs, audit });
}
