import { createClient } from "@libsql/client";
import { prisma } from "@/lib/db";
import { createExecutionQueueTask } from "@/lib/execution-queue";
import type { ChatMessageView } from "@/lib/chat";

const HERMES_NOUS_TARGET = "hermes_nous";

type Db = ReturnType<typeof createClient>;

function getDb(): Db {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function toView(row: {
  id: string;
  role: string;
  content: string;
  channel: string;
  targetAgent: string | null;
  createdAt: Date;
}): ChatMessageView {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    channel: row.channel === "telegram" ? "telegram" : "dashboard",
    targetAgent: row.targetAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function ensureHermesNousChatSessionTable(): Promise<void> {
  const db = getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS HermesNousChatSession (
      userId TEXT PRIMARY KEY,
      hermesSessionId TEXT,
      lastTaskId TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
}

export async function getHermesNousSessionId(userId: string): Promise<string | null> {
  await ensureHermesNousChatSessionTable();
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT hermesSessionId FROM HermesNousChatSession WHERE userId = ? LIMIT 1`,
    args: [userId],
  });
  const value = res.rows[0]?.hermesSessionId;
  return typeof value === "string" && value.trim() ? value : null;
}

export async function listHermesNousMessages(userId: string, limit = 50): Promise<ChatMessageView[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { userId, targetAgent: HERMES_NOUS_TARGET },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toView).reverse();
}

export async function queueHermesNousMessage(userId: string, message: string): Promise<{
  userMessage: ChatMessageView;
  taskId: string;
  hermesSessionId: string | null;
}> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("message is required");

  await ensureHermesNousChatSessionTable();
  const hermesSessionId = await getHermesNousSessionId(userId);
  const userRow = await prisma.chatMessage.create({
    data: { userId, role: "user", content: trimmed, channel: "dashboard", targetAgent: HERMES_NOUS_TARGET },
  });
  const payload = JSON.stringify({
    type: "hermes_chat",
    message: trimmed,
    chatMessageId: userRow.id,
    hermesSessionId,
  });
  const task = await createExecutionQueueTask({
    userId,
    title: `Hermes Nous chat: ${trimmed.slice(0, 80)}`,
    description: payload,
    priority: "high",
    assignedExecutor: "hermes_chat",
    initialLog: hermesSessionId ? `Queued Hermes Nous chat on session ${hermesSessionId}.` : "Queued new Hermes Nous chat session.",
  });

  const db = getDb();
  await db.execute({
    sql: `INSERT INTO HermesNousChatSession (userId, hermesSessionId, lastTaskId, createdAt, updatedAt)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(userId) DO UPDATE SET lastTaskId = excluded.lastTaskId, updatedAt = datetime('now')`,
    args: [userId, hermesSessionId, task.id],
  });

  return { userMessage: toView(userRow), taskId: task.id, hermesSessionId };
}
