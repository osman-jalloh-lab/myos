import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { createApproval } from "@/lib/approvals";
import { contextCards } from "@/lib/memory";

export type MemoryCenterItem = {
  id: string;
  fact: string;
  source: string | null;
  date: string;
  confidence: number;
  whereUsed: string[];
  pinned: boolean;
  archived: boolean;
};

export type InferredMemorySuggestion = {
  id: string;
  fact: string;
  source: string | null;
  date: string;
  confidence: number;
  whereUsed: string[];
  status: string;
};

export type ProjectDecisionItem = {
  id: string;
  projectName: string;
  status: string;
  decision: string;
  source: string;
  date: string;
  confidence: number;
  whereUsed: string[];
};

export type OperationalLessonItem = {
  id: string;
  lesson: string;
  source: string;
  date: string;
  confidence: number;
  whereUsed: string[];
};

export type MemoryUseItem = {
  id: string;
  runId: string | null;
  agentName: string | null;
  taskType: string | null;
  query: string;
  retrieved: Array<{ id: string; fact: string; source: string | null; confidence: number }>;
  createdAt: string;
};

export type MemoryRetrievalResult = {
  confirmedFacts: Array<{ id: string; fact: string; source: string | null; confidence: number }>;
  projectDecisions: ProjectDecisionItem[];
  redactedCount: number;
};

type MemoryStateRow = {
  memoryId: string;
  pinned: number | bigint;
  archived: number | bigint;
  confidence: number | bigint | null;
};

type UsageRow = {
  id: string;
  runId: string | null;
  agentName: string | null;
  taskType: string | null;
  query: string;
  retrievedJson: string;
  createdAt: Date | string;
};

type ProjectRow = {
  id: string;
  projectName: string | null;
  status: string | null;
  latestInstruction: string | null;
  localResearchBrief: string | null;
  localBuildError: string | null;
  localBuildLog: string | null;
  updatedAt: Date | string | null;
};

const SECRET_RE = /\b(api[_\s-]?key|token|secret|password|credential|cookie)\b/i;
const SECRET_VALUE_RE = /(api[_\s-]?key|token|secret|password|credential|cookie)\s*(?:is|=|:)\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi;

function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function sanitizeMemoryForPrompt(fact: string): { text: string; redacted: boolean } {
  const redacted = SECRET_RE.test(fact);
  return {
    text: fact.replace(SECRET_VALUE_RE, (_match, label: string) => `${String(label).replace(/\s+/g, " ")} is configured`),
    redacted,
  };
}

async function ensureMemoryCenterTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS MemoryItemState (
      userId TEXT NOT NULL,
      memoryId TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      confidence INTEGER NOT NULL DEFAULT 100,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, memoryId)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS MemoryRetrievalLog (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      runId TEXT,
      agentName TEXT,
      taskType TEXT,
      query TEXT NOT NULL,
      retrievedJson TEXT NOT NULL,
      redactedCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS MemoryRetrievalLog_userId_createdAt_idx ON MemoryRetrievalLog(userId, createdAt)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS MemoryRetrievalLog_runId_idx ON MemoryRetrievalLog(runId)`);
}

async function stateByMemory(userId: string): Promise<Map<string, MemoryStateRow>> {
  await ensureMemoryCenterTables();
  const rows = await prisma.$queryRawUnsafe<MemoryStateRow[]>(
    `SELECT memoryId, pinned, archived, confidence FROM MemoryItemState WHERE userId = ?`,
    userId,
  ).catch(() => []);
  return new Map(rows.map((row) => [row.memoryId, row]));
}

async function whereUsedByMemory(userId: string, memoryIds: string[]): Promise<Map<string, string[]>> {
  await ensureMemoryCenterTables();
  if (memoryIds.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<UsageRow[]>(
    `SELECT id, runId, agentName, taskType, query, retrievedJson, createdAt
     FROM MemoryRetrievalLog
     WHERE userId = ?
     ORDER BY createdAt DESC
     LIMIT 80`,
    userId,
  ).catch(() => []);
  const out = new Map<string, string[]>();
  for (const row of rows) {
    let retrieved: Array<{ id?: string; fact?: string }> = [];
    try {
      retrieved = JSON.parse(row.retrievedJson) as Array<{ id?: string; fact?: string }>;
    } catch {
      retrieved = [];
    }
    for (const item of retrieved) {
      if (!item.id || !memoryIds.includes(item.id)) continue;
      const label = `${row.agentName ?? "agent"}${row.taskType ? ` / ${row.taskType}` : ""}${row.runId ? ` / run ${row.runId.slice(0, 8)}` : ""}`;
      out.set(item.id, [...(out.get(item.id) ?? []), label]);
    }
  }
  return out;
}

function pendingPayload(row: { payload: string }): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function listConfirmedMemory(userId: string, includeArchived = false): Promise<MemoryCenterItem[]> {
  const [memories, states] = await Promise.all([
    prisma.memory.findMany({
      where: { userId, approvedAt: { not: null } },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    }),
    stateByMemory(userId),
  ]);
  const ids = memories.map((memory) => memory.id);
  const usage = await whereUsedByMemory(userId, ids);
  return memories
    .map((memory) => {
      const state = states.get(memory.id);
      return {
        id: memory.id,
        fact: memory.fact,
        source: memory.source,
        date: memory.approvedAt?.toISOString() ?? memory.createdAt.toISOString(),
        confidence: Number(state?.confidence ?? 100),
        whereUsed: usage.get(memory.id) ?? [],
        pinned: Boolean(Number(state?.pinned ?? 0)),
        archived: Boolean(Number(state?.archived ?? 0)),
      };
    })
    .filter((memory) => includeArchived || !memory.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function listInferredMemorySuggestions(userId: string): Promise<InferredMemorySuggestion[]> {
  const rows = await prisma.approvalAction.findMany({
    where: { userId, actionType: "save_memory", status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((row) => {
    const payload = pendingPayload(row);
    return {
      id: row.id,
      fact: String(payload.fact ?? ""),
      source: typeof payload.source === "string" ? payload.source : "memory-suggest",
      date: row.createdAt.toISOString(),
      confidence: typeof payload.confidence === "number" ? payload.confidence : 70,
      whereUsed: typeof payload.whereUsed === "string" ? [payload.whereUsed] : [],
      status: row.status,
    };
  }).filter((item) => item.fact);
}

export async function listProjectDecisions(userId: string, max = 20): Promise<ProjectDecisionItem[]> {
  const rows = await prisma.$queryRawUnsafe<ProjectRow[]>(
    `SELECT id, projectName, status, latestInstruction, localResearchBrief, localBuildError, localBuildLog, updatedAt
     FROM Project
     WHERE userId = ?
     ORDER BY updatedAt DESC
     LIMIT ?`,
    userId,
    max,
  ).catch(() => []);
  return rows
    .map((row) => ({
      id: row.id,
      projectName: row.projectName ?? "Project",
      status: row.status ?? "active",
      decision: row.latestInstruction ?? row.localResearchBrief ?? "",
      source: "Project.latestInstruction",
      date: iso(row.updatedAt),
      confidence: 100,
      whereUsed: [],
    }))
    .filter((row) => row.decision);
}

export async function listOperationalLessons(userId: string, max = 20): Promise<OperationalLessonItem[]> {
  const [runs, toolFailures] = await Promise.all([
    prisma.agentRun.findMany({
      where: {
        OR: [
          { agentName: { contains: "builder" } },
          { inputSummary: { contains: "local_build" } },
          { status: { in: ["failed", "completed"] } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: max,
    }).catch(() => []),
    prisma.memory.findMany({
      where: { userId, source: { startsWith: "tool-health:" } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }).catch(() => []),
  ]);
  return [
    ...toolFailures.map((failure) => ({
      id: failure.id,
      lesson: failure.fact,
      source: failure.source ?? "tool-health",
      date: failure.createdAt.toISOString(),
      confidence: 90,
      whereUsed: [],
    })),
    ...runs.map((run) => ({
      id: run.id,
      lesson: run.outputSummary || run.inputSummary || "Agent run completed.",
      source: `AgentRun:${run.agentName}`,
      date: run.createdAt.toISOString(),
      confidence: run.status === "failed" ? 85 : 75,
      whereUsed: [],
    })),
  ].filter((lesson) => lesson.lesson).slice(0, max);
}

export async function listRecentMemoryUse(userId: string, max = 20): Promise<MemoryUseItem[]> {
  await ensureMemoryCenterTables();
  const rows = await prisma.$queryRawUnsafe<UsageRow[]>(
    `SELECT id, runId, agentName, taskType, query, retrievedJson, createdAt
     FROM MemoryRetrievalLog
     WHERE userId = ?
     ORDER BY createdAt DESC
     LIMIT ?`,
    userId,
    max,
  ).catch(() => []);
  return rows.map((row) => {
    let retrieved: MemoryUseItem["retrieved"] = [];
    try {
      retrieved = JSON.parse(row.retrievedJson) as MemoryUseItem["retrieved"];
    } catch {
      retrieved = [];
    }
    return {
      id: row.id,
      runId: row.runId,
      agentName: row.agentName,
      taskType: row.taskType,
      query: row.query,
      retrieved,
      createdAt: iso(row.createdAt),
    };
  });
}

export async function retrieveMemoryForPrompt(params: {
  userId: string;
  message: string;
  agentName?: string | null;
  taskType?: string | null;
  projectId?: string | null;
  runId?: string | null;
  maxFacts?: number;
}): Promise<MemoryRetrievalResult> {
  const maxFacts = Math.max(1, Math.min(8, params.maxFacts ?? 6));
  const [cards, states, projectDecisions] = await Promise.all([
    contextCards(params.userId, params.message, maxFacts),
    stateByMemory(params.userId),
    listProjectDecisions(params.userId, 6),
  ]);
  const memories = await prisma.memory.findMany({
    where: {
      userId: params.userId,
      approvedAt: { not: null },
      fact: { in: cards.map((card) => card.fact) },
    },
    select: { id: true, fact: true, source: true },
  }).catch(() => []);
  const byFact = new Map(memories.map((memory) => [memory.fact, memory]));
  let redactedCount = 0;
  const confirmedFacts = cards.map((card) => {
    const memory = byFact.get(card.fact);
    const sanitized = sanitizeMemoryForPrompt(card.fact);
    if (sanitized.redacted) redactedCount += 1;
    const state = memory ? states.get(memory.id) : undefined;
    return {
      id: memory?.id ?? crypto.randomUUID(),
      fact: sanitized.text,
      source: card.source,
      confidence: Math.max(Number(state?.confidence ?? 100), Math.min(100, 50 + card.relevance * 10)),
    };
  });
  const relevantDecisionWords = params.message.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  const relevantProjectDecisions = projectDecisions
    .filter((decision) => relevantDecisionWords.some((word) => decision.decision.toLowerCase().includes(word) || decision.projectName.toLowerCase().includes(word)))
    .slice(0, 3);

  await ensureMemoryCenterTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO MemoryRetrievalLog (id, userId, runId, agentName, taskType, query, retrievedJson, redactedCount, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    crypto.randomUUID(),
    params.userId,
    params.runId ?? null,
    params.agentName ?? null,
    params.taskType ?? null,
    params.message.slice(0, 500),
    JSON.stringify(confirmedFacts),
    redactedCount,
  );

  return { confirmedFacts, projectDecisions: relevantProjectDecisions, redactedCount };
}

export async function setMemoryPinned(userId: string, memoryId: string, pinned: boolean): Promise<void> {
  await ensureMemoryCenterTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO MemoryItemState (userId, memoryId, pinned, updatedAt) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(userId, memoryId) DO UPDATE SET pinned = excluded.pinned, updatedAt = datetime('now')`,
    userId,
    memoryId,
    pinned ? 1 : 0,
  );
}

export async function setMemoryArchived(userId: string, memoryId: string, archived: boolean): Promise<void> {
  await ensureMemoryCenterTables();
  await prisma.$executeRawUnsafe(
    `INSERT INTO MemoryItemState (userId, memoryId, archived, updatedAt) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(userId, memoryId) DO UPDATE SET archived = excluded.archived, updatedAt = datetime('now')`,
    userId,
    memoryId,
    archived ? 1 : 0,
  );
}

export async function editMemoryFact(userId: string, memoryId: string, fact: string): Promise<void> {
  const cleaned = fact.trim().replace(/\s+/g, " ").slice(0, 500);
  if (!cleaned) throw new Error("Memory fact cannot be empty.");
  await prisma.memory.updateMany({ where: { id: memoryId, userId }, data: { fact: cleaned } });
}

export async function proposeDeleteMemory(userId: string, memoryId: string): Promise<unknown> {
  const memory = await prisma.memory.findFirstOrThrow({ where: { id: memoryId, userId } });
  return createApproval(userId, "delete_memory", {
    memoryId,
    fact: memory.fact,
    reason: "Requested from Memory Center.",
  });
}

export async function proposeInferredMemory(userId: string, fact: string, source = "memory-center:inferred", confidence = 70): Promise<unknown> {
  return createApproval(userId, "save_memory", {
    fact: fact.trim().replace(/\s+/g, " ").slice(0, 500),
    source,
    confidence,
  });
}
