import { createClient } from "@libsql/client";
import crypto from "node:crypto";

type Db = ReturnType<typeof createClient>;

export const EXECUTOR_TYPES = ["hermes", "local_worker", "hermes_agent", "hermes_chat", "council_chat", "codex_cli"] as const;
export type ExecutorType = typeof EXECUTOR_TYPES[number];

export type ExecutionQueueStatus =
  | "queued"
  | "planning"
  | "executing"
  | "qa_pending"
  | "qa_passed"
  | "waiting_approval"
  | "completed"
  | "failed";

export type ExecutionQueueTask = {
  id: string;
  title: string;
  description: string;
  status: ExecutionQueueStatus;
  priority: string;
  assignedExecutor: ExecutorType | string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  result: string | null;
  logs: string[];
};

function getDb(): Db {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeStatus(status: string): ExecutionQueueStatus {
  if (status === "running") return "executing";
  if (status === "blocked" || status === "approval_required") return "waiting_approval";
  if (["queued", "planning", "executing", "qa_pending", "qa_passed", "waiting_approval", "completed", "failed"].includes(status)) {
    return status as ExecutionQueueStatus;
  }
  return "queued";
}

function parseLogs(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    return value.split("\n").filter(Boolean);
  }
  return [];
}

function serializeLog(existing: unknown, message: string): string {
  const logs = parseLogs(existing);
  logs.push(`${new Date().toISOString()} ${message}`);
  return JSON.stringify(logs.slice(-80));
}

function rowToTask(row: Record<string, unknown>): ExecutionQueueTask {
  return {
    id: asString(row.id),
    title: asString(row.title),
    description: asString(row.description),
    status: normalizeStatus(asString(row.status)),
    priority: asString(row.priority) || "medium",
    assignedExecutor: asString(row.assigned_executor) || "hermes",
    projectId: nullableString(row.project_id),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    result: nullableString(row.result) ?? nullableString(row.error),
    logs: parseLogs(row.logs),
  };
}

export async function ensureExecutionQueue(): Promise<void> {
  const db = getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS AgentTask (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      files TEXT,
      result TEXT,
      error TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN priority TEXT DEFAULT 'medium'`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN assigned_executor TEXT DEFAULT 'hermes'`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN project_id TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN logs TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN files TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN result TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN error TEXT`).catch(() => undefined);
}

export async function createExecutionQueueTask(params: {
  userId: string;
  title: string;
  description: string;
  priority?: string;
  assignedExecutor?: string;
  projectId?: string | null;
  initialLog?: string;
}): Promise<ExecutionQueueTask> {
  await ensureExecutionQueue();
  const db = getDb();
  const id = crypto.randomUUID();
  const logs = params.initialLog ? serializeLog(null, params.initialLog) : JSON.stringify([]);
  await db.execute({
    sql: `INSERT INTO AgentTask (id, userId, title, description, status, priority, assigned_executor, project_id, logs, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [
      id,
      params.userId,
      params.title.slice(0, 200),
      params.description.slice(0, 2000),
      params.priority ?? "medium",
      params.assignedExecutor ?? "hermes",
      params.projectId ?? null,
      logs,
    ],
  });
  const task = await getExecutionQueueTask(params.userId, id);
  if (!task) throw new Error("Execution queue task was not created.");
  return task;
}

export async function updateExecutionQueueTask(
  userId: string,
  taskId: string,
  updates: {
    status?: ExecutionQueueStatus;
    assignedExecutor?: string;
    result?: string | null;
    error?: string | null;
    log?: string;
  }
): Promise<ExecutionQueueTask | null> {
  await ensureExecutionQueue();
  const db = getDb();
  const current = await db.execute({
    sql: `SELECT logs FROM AgentTask WHERE id = ? AND userId = ? LIMIT 1`,
    args: [taskId, userId],
  });
  if (!current.rows.length) return null;

  const fields: string[] = [];
  const args: (string | null)[] = [];
  if (updates.status) {
    fields.push("status = ?");
    args.push(updates.status);
  }
  if (updates.assignedExecutor) {
    fields.push("assigned_executor = ?");
    args.push(updates.assignedExecutor);
  }
  if (updates.result !== undefined) {
    fields.push("result = ?");
    args.push(updates.result ? updates.result.slice(0, 2000) : null);
  }
  if (updates.error !== undefined) {
    fields.push("error = ?");
    args.push(updates.error ? updates.error.slice(0, 1000) : null);
  }
  if (updates.log) {
    fields.push("logs = ?");
    args.push(serializeLog((current.rows[0] as Record<string, unknown>).logs, updates.log));
  }
  if (!fields.length) return getExecutionQueueTask(userId, taskId);

  fields.push("updatedAt = datetime('now')");
  args.push(taskId, userId);
  await db.execute({
    sql: `UPDATE AgentTask SET ${fields.join(", ")} WHERE id = ? AND userId = ?`,
    args,
  });
  return getExecutionQueueTask(userId, taskId);
}

export async function getExecutionQueueTask(userId: string, taskId: string): Promise<ExecutionQueueTask | null> {
  await ensureExecutionQueue();
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM AgentTask WHERE id = ? AND userId = ? LIMIT 1`,
    args: [taskId, userId],
  });
  return res.rows.length ? rowToTask(res.rows[0] as Record<string, unknown>) : null;
}

export async function listExecutionQueue(userId: string, limit = 50): Promise<ExecutionQueueTask[]> {
  await ensureExecutionQueue();
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM AgentTask WHERE userId = ? ORDER BY updatedAt DESC LIMIT ?`,
    args: [userId, limit],
  });
  return res.rows.map((row) => rowToTask(row as Record<string, unknown>));
}
