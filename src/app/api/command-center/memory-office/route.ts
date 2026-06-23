import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

const TEST_MEMORY = "Local Builder pipeline works: Hermes can prepare a folder, generate a Next.js app, run build, and start dev server inside HermesProject.";

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const [memories, projectsForUser, allProjects, runs] = await Promise.all([
    prisma.memory.findMany({
      where: { userId, approvedAt: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    getDb().execute({
      sql: `SELECT * FROM Project WHERE userId = ? ORDER BY updatedAt DESC LIMIT 20`,
      args: [userId],
    }).catch(() => ({ rows: [] })),
    getDb().execute({
      sql: `SELECT * FROM Project ORDER BY updatedAt DESC LIMIT 20`,
      args: [],
    }).catch(() => ({ rows: [] })),
    getDb().execute({
      sql: `SELECT * FROM AgentRun ORDER BY createdAt DESC LIMIT 40`,
      args: [],
    }).catch(() => ({ rows: [] })),
  ]);

  const projectRows = (projectsForUser.rows.length ? projectsForUser.rows : allProjects.rows) as Record<string, unknown>[];
  const runRows = runs.rows as Record<string, unknown>[];

  return NextResponse.json({
    memories: memories.map((m) => ({
      id: m.id,
      fact: m.fact,
      source: m.source,
      createdAt: m.createdAt.toISOString(),
      approvedAt: m.approvedAt?.toISOString() ?? null,
    })),
    projectDecisions: projectRows.map((p) => ({
      id: asString(p.id),
      projectName: asString(p.projectName),
      status: asString(p.status),
      decision: asString(p.latestInstruction) || asString(p.localFolderPath),
      updatedAt: asString(p.updatedAt),
    })).filter((p) => p.decision),
    buildLessons: runRows
      .filter((r) => asString(r.agentName).includes("builder") || asString(r.inputSummary).includes("local_build"))
      .map((r) => ({
        id: asString(r.id),
        status: asString(r.status),
        summary: asString(r.outputSummary),
        createdAt: asString(r.createdAt),
      })),
    researchBriefs: projectRows
      .filter((p) => asString(p.localResearchBrief))
      .map((p) => ({
        id: asString(p.id),
        projectName: asString(p.projectName),
        brief: asString(p.localResearchBrief),
        updatedAt: asString(p.updatedAt),
      })),
    failedBuildFixes: projectRows
      .filter((p) => asString(p.localBuildError) || asString(p.localBuildLog).toLowerCase().includes("fix"))
      .map((p) => ({
        id: asString(p.id),
        projectName: asString(p.projectName),
        error: asString(p.localBuildError),
        log: asString(p.localBuildLog),
        updatedAt: asString(p.updatedAt),
      })),
    userPreferences: memories
      .filter((m) => /prefer|preference|style|local builder|HermesProject/i.test(m.fact))
      .map((m) => ({ id: m.id, fact: m.fact, source: m.source, createdAt: m.createdAt.toISOString() })),
    lastUpdated: new Date().toISOString(),
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: string; recommendation?: string } | null;

  if (body?.action === "createTestMemory") {
    const existing = await prisma.memory.findFirst({ where: { userId: session.user.id, fact: TEST_MEMORY } });
    const memory = existing ?? await prisma.memory.create({
      data: {
        userId: session.user.id,
        fact: TEST_MEMORY,
        source: "memory-office:test",
        approvedAt: new Date(),
      },
    });
    return NextResponse.json({ memory });
  }

  if (body?.action === "saveSkillRecommendation") {
    const fact = body.recommendation?.trim() || "Skill Scout recommendation: accessibility audit skill would help Hermes verify generated apps before completion.";
    const memory = await prisma.memory.create({
      data: {
        userId: session.user.id,
        fact,
        source: "skill-scout:manual-recommendation",
        approvedAt: new Date(),
      },
    });
    return NextResponse.json({ memory });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
