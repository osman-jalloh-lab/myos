import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  parseSessionJson,
  recentToolFailures,
  toolHealthFromEnvironment,
  type RememberedEntities,
  type ToolHealthEntry,
} from "@/lib/context-persistence";

type DbRow = Record<string, string | number | null | undefined>;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function ensureDebugColumns(): Promise<void> {
  const db = getDb();
  await db.execute(`ALTER TABLE AgentSession ADD COLUMN activeIntent TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentSession ADD COLUMN rememberedEntities TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentSession ADD COLUMN toolHealth TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentSession ADD COLUMN recentFailures TEXT`).catch(() => undefined);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  await ensureDebugColumns().catch(() => undefined);

  const [sessionRes, recentMessages, pendingApprovals, failures] = await Promise.all([
    getDb().execute({
      sql: `SELECT * FROM AgentSession WHERE userId = ? ORDER BY lastUpdated DESC LIMIT 1`,
      args: [userId],
    }).catch(() => ({ rows: [] })),
    prisma.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, role: true, content: true, channel: true, targetAgent: true, createdAt: true },
    }),
    prisma.approvalAction.findMany({
      where: { userId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, actionType: true, createdAt: true },
    }),
    recentToolFailures(userId, 8).catch(() => []),
  ]);

  const row = sessionRes.rows[0] as DbRow | undefined;
  const rememberedEntities = parseSessionJson<RememberedEntities>(str(row?.rememberedEntities), {});
  const toolHealth = parseSessionJson<ToolHealthEntry[]>(str(row?.toolHealth), toolHealthFromEnvironment());

  return NextResponse.json({
    activeSession: row
      ? {
          id: str(row.id),
          chatId: str(row.chatId),
          userId: str(row.userId),
          lastUpdated: str(row.lastUpdated),
        }
      : null,
    activeIntent: str(row?.activeIntent),
    activeTask: str(row?.currentTask),
    activeProjectId: str(row?.activeProjectId),
    rememberedEntities,
    toolHealth,
    recentFailures: failures,
    pendingApprovals: pendingApprovals.map((approval) => ({
      id: approval.id,
      actionType: approval.actionType,
      createdAt: approval.createdAt.toISOString(),
    })),
    last20MessagesLoaded: recentMessages.reverse().map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      channel: message.channel,
      targetAgent: message.targetAgent,
      createdAt: message.createdAt.toISOString(),
    })),
    lastUpdated: new Date().toISOString(),
  });
}
