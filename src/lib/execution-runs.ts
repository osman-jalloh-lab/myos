import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { createExecutionQueueTask, getExecutionQueueTask } from "@/lib/execution-queue";

export const EXECUTION_PHASES = [
  "queued", "claimed", "initializing", "planning", "fugu_design_gate",
  "waiting_for_worker", "waiting_for_approval", "preparing_workspace",
  "hermes_nous_running", "codex_fallback_running", "installing_dependencies",
  "building", "starting_preview", "browser_qa", "fugu_polish_review",
  "completed", "failed", "cancelled", "stalled",
] as const;

export type ExecutionPhase = typeof EXECUTION_PHASES[number];
export type ExecutionSeverity = "info" | "warning" | "error";
export type ExecutionSource = "web" | "local_worker" | "hermes_nous" | "codex" | "fugu" | "qa";
export type ExecutionRunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "stalled";
export type ExecutionRunExecutor = "hermes_agent" | "codex_cli" | "local_worker" | "internal";

export type ExecutionTraceEventView = {
  id: string;
  runId: string;
  phase: ExecutionPhase;
  severity: ExecutionSeverity;
  message: string;
  source: ExecutionSource;
  safeDetails?: Record<string, unknown>;
  createdAt: string;
};

export type ExecutionRunView = {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  parentRunId: string | null;
  executor: ExecutionRunExecutor;
  currentPhase: ExecutionPhase;
  currentActivity: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  lastMeaningfulEventAt: string;
  completedAt: string | null;
  status: ExecutionRunStatus;
  lastSafeError: string | null;
  workerId: string | null;
  localFolderPath: string | null;
  fallbackReason: string | null;
  cancellationRequestedAt: string | null;
  elapsedMs: number;
  heartbeatAgeMs: number;
  meaningfulEventAgeMs: number;
  stuckReason: string | null;
  latestEvent: ExecutionTraceEventView | null;
};

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /(?:^|\s)(?:sk|pk|ghp|gho|ghu|ghs|xoxb)-[A-Za-z0-9_-]{12,}/gi,
];

export function redactExecutionText(value: unknown, max = 2000): string {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  text = text.replace(/(?:postgres|mysql|libsql|mongodb|redis):\/\/[^\s"'<>]+/gi, "[redacted-connection-string]");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, label?: string) => label ? `${label}=[redacted]` : "[redacted]");
  }
  text = text.replace(/\.env(?:\.[A-Za-z0-9_-]+)?/g, "[env-file]");
  return text.slice(0, max);
}

function sanitizeDetails(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  const entries = Object.entries(value).slice(0, 30).map(([key, raw]) => {
    const safeKey = redactExecutionText(key, 80);
    if (raw === null || raw === undefined || typeof raw === "number" || typeof raw === "boolean") return [safeKey, raw];
    if (Array.isArray(raw)) return [safeKey, raw.slice(0, 20).map((item) => redactExecutionText(item, 240))];
    if (typeof raw === "object") return [safeKey, redactExecutionText(raw, 500)];
    return [safeKey, redactExecutionText(raw, 500)];
  });
  return JSON.stringify(Object.fromEntries(entries)).slice(0, 4000);
}

function parseDetails(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return { detail: redactExecutionText(value, 1000) };
  }
}

export async function ensureExecutionRunTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ExecutionRun (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      projectId TEXT,
      taskId TEXT,
      parentRunId TEXT,
      executor TEXT NOT NULL,
      currentPhase TEXT NOT NULL DEFAULT 'queued',
      currentActivity TEXT,
      startedAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastHeartbeatAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastMeaningfulEventAt TEXT NOT NULL DEFAULT (datetime('now')),
      completedAt TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      lastSafeError TEXT,
      workerId TEXT,
      localFolderPath TEXT,
      fallbackReason TEXT,
      cancellationRequestedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ExecutionTraceEvent (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      phase TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      safeDetails TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ExecutionRun_userId_status_idx ON ExecutionRun(userId, status)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ExecutionRun_userId_startedAt_idx ON ExecutionRun(userId, startedAt)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ExecutionRun_taskId_idx ON ExecutionRun(taskId)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ExecutionRun_projectId_idx ON ExecutionRun(projectId)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ExecutionTraceEvent_runId_createdAt_idx ON ExecutionTraceEvent(runId, createdAt)`);
}

type RunRow = {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  parentRunId: string | null;
  executor: string;
  currentPhase: string;
  currentActivity: string | null;
  startedAt: Date | string;
  lastHeartbeatAt: Date | string;
  lastMeaningfulEventAt: Date | string;
  completedAt: Date | string | null;
  status: string;
  lastSafeError: string | null;
  workerId: string | null;
  localFolderPath: string | null;
  fallbackReason: string | null;
  cancellationRequestedAt: Date | string | null;
};

type EventRow = {
  id: string;
  runId: string;
  phase: string;
  severity: string;
  message: string;
  source: string;
  safeDetails: string | null;
  createdAt: Date | string;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function eventView(row: EventRow): ExecutionTraceEventView {
  return {
    id: row.id,
    runId: row.runId,
    phase: row.phase as ExecutionPhase,
    severity: row.severity as ExecutionSeverity,
    message: row.message,
    source: row.source as ExecutionSource,
    safeDetails: parseDetails(row.safeDetails),
    createdAt: iso(row.createdAt)!,
  };
}

function stuckReason(row: RunRow): string | null {
  if (["completed", "failed", "cancelled"].includes(row.status)) return null;
  const meaningfulAge = Date.now() - new Date(row.lastMeaningfulEventAt).getTime();
  if (row.status === "stalled") return `No meaningful event for ${Math.round(meaningfulAge / 1000)}s.`;
  if (meaningfulAge >= 180_000) return `Would be marked stalled: no meaningful event for ${Math.round(meaningfulAge / 1000)}s.`;
  if (meaningfulAge >= 90_000) return `Warning: no meaningful event for ${Math.round(meaningfulAge / 1000)}s.`;
  if (row.cancellationRequestedAt) return "Cancellation requested; waiting for local worker confirmation.";
  return null;
}

function runView(row: RunRow, latestEvent: EventRow | null = null): ExecutionRunView {
  const startedAt = new Date(row.startedAt);
  const heartbeatAt = new Date(row.lastHeartbeatAt);
  const meaningfulAt = new Date(row.lastMeaningfulEventAt);
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    taskId: row.taskId,
    parentRunId: row.parentRunId,
    executor: row.executor as ExecutionRunExecutor,
    currentPhase: row.currentPhase as ExecutionPhase,
    currentActivity: row.currentActivity,
    startedAt: startedAt.toISOString(),
    lastHeartbeatAt: heartbeatAt.toISOString(),
    lastMeaningfulEventAt: meaningfulAt.toISOString(),
    completedAt: iso(row.completedAt),
    status: row.status as ExecutionRunStatus,
    lastSafeError: row.lastSafeError,
    workerId: row.workerId,
    localFolderPath: row.localFolderPath,
    fallbackReason: row.fallbackReason,
    cancellationRequestedAt: iso(row.cancellationRequestedAt),
    elapsedMs: (row.completedAt ? new Date(row.completedAt).getTime() : Date.now()) - startedAt.getTime(),
    heartbeatAgeMs: Date.now() - heartbeatAt.getTime(),
    meaningfulEventAgeMs: Date.now() - meaningfulAt.getTime(),
    stuckReason: stuckReason(row),
    latestEvent: latestEvent ? eventView(latestEvent) : null,
  };
}

export async function createExecutionRun(params: {
  id?: string | null;
  userId: string;
  projectId?: string | null;
  taskId?: string | null;
  parentRunId?: string | null;
  executor: ExecutionRunExecutor | string;
  currentPhase?: ExecutionPhase;
  currentActivity?: string;
  localFolderPath?: string | null;
  fallbackReason?: string | null;
}): Promise<ExecutionRunView> {
  await ensureExecutionRunTables();
  const id = params.id ?? crypto.randomUUID();
  const now = new Date();
  await prisma.executionRun.create({
    data: {
      id,
      userId: params.userId,
      projectId: params.projectId ?? null,
      taskId: params.taskId ?? null,
      parentRunId: params.parentRunId ?? null,
      executor: params.executor,
      currentPhase: params.currentPhase ?? "queued",
      currentActivity: params.currentActivity,
      localFolderPath: params.localFolderPath,
      fallbackReason: params.fallbackReason,
      status: params.currentPhase === "waiting_for_approval" ? "waiting_approval" : "queued",
      startedAt: now,
      lastHeartbeatAt: now,
      lastMeaningfulEventAt: now,
    },
  });
  await appendExecutionEvent(id, {
    phase: params.currentPhase ?? "queued",
    source: "web",
    severity: "info",
    message: params.currentActivity ?? "Run queued.",
    meaningful: true,
  });
  const run = await getExecutionRun(params.userId, id);
  if (!run) throw new Error("Execution run was not created.");
  return run;
}

export async function appendExecutionEvent(runId: string, params: {
  phase: ExecutionPhase;
  source: ExecutionSource;
  severity?: ExecutionSeverity;
  message: string;
  safeDetails?: Record<string, unknown>;
  meaningful?: boolean;
  status?: ExecutionRunStatus;
  workerId?: string | null;
  localFolderPath?: string | null;
  lastSafeError?: string | null;
}): Promise<ExecutionTraceEventView | null> {
  await ensureExecutionRunTables();
  const run = await prisma.executionRun.findUnique({ where: { id: runId } }).catch(() => null);
  if (!run) return null;
  const safeMessage = redactExecutionText(params.message, 700);
  const event = await prisma.executionTraceEvent.create({
    data: {
      runId,
      phase: params.phase,
      severity: params.severity ?? "info",
      source: params.source,
      message: safeMessage,
      safeDetails: sanitizeDetails(params.safeDetails),
    },
  });
  const terminal = ["completed", "failed", "cancelled"].includes(params.phase);
  await prisma.executionRun.update({
    where: { id: runId },
    data: {
      currentPhase: params.phase,
      currentActivity: safeMessage,
      status: params.status ?? (terminal ? params.phase : run.status === "queued" ? "running" : run.status),
      lastHeartbeatAt: new Date(),
      lastMeaningfulEventAt: params.meaningful === false ? undefined : new Date(),
      completedAt: terminal ? new Date() : undefined,
      workerId: params.workerId ?? undefined,
      localFolderPath: params.localFolderPath ?? undefined,
      lastSafeError: params.lastSafeError ? redactExecutionText(params.lastSafeError, 1000) : undefined,
    },
  });
  return eventView(event as EventRow);
}

export async function heartbeatExecutionRun(runId: string, params: { workerId?: string | null; activity?: string }): Promise<void> {
  await ensureExecutionRunTables();
  await prisma.executionRun.update({
    where: { id: runId },
    data: {
      lastHeartbeatAt: new Date(),
      workerId: params.workerId ?? undefined,
      currentActivity: params.activity ? redactExecutionText(params.activity, 700) : undefined,
    },
  }).catch(() => undefined);
}

export async function getExecutionRun(userId: string, runId: string): Promise<ExecutionRunView | null> {
  await ensureExecutionRunTables();
  const row = await prisma.executionRun.findFirst({ where: { id: runId, userId } }).catch(() => null);
  if (!row) return null;
  const latest = await prisma.executionTraceEvent.findFirst({ where: { runId }, orderBy: { createdAt: "desc" } }).catch(() => null);
  return runView(row as RunRow, latest as EventRow | null);
}

export async function listExecutionRuns(userId: string, limit = 30): Promise<ExecutionRunView[]> {
  await ensureExecutionRunTables();
  await markStalledRuns(userId);
  const rows = await prisma.executionRun.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  const latestEvents = await prisma.executionTraceEvent.findMany({
    where: { runId: { in: rows.map((row) => row.id) } },
    orderBy: { createdAt: "desc" },
  }).catch(() => []);
  const byRun = new Map<string, EventRow>();
  for (const event of latestEvents as EventRow[]) if (!byRun.has(event.runId)) byRun.set(event.runId, event);
  return rows.map((row) => runView(row as RunRow, byRun.get(row.id) ?? null));
}

export async function listExecutionEvents(userId: string, runId: string, limit = 120): Promise<ExecutionTraceEventView[] | null> {
  const run = await getExecutionRun(userId, runId);
  if (!run) return null;
  const rows = await prisma.executionTraceEvent.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return (rows as EventRow[]).map(eventView);
}

export async function requestRunCancellation(userId: string, runId: string): Promise<ExecutionRunView | null> {
  await ensureExecutionRunTables();
  const row = await prisma.executionRun.findFirst({ where: { id: runId, userId } });
  if (!row) return null;
  if (["completed", "failed", "cancelled"].includes(row.status)) return runView(row as RunRow);
  await prisma.executionRun.update({
    where: { id: runId },
    data: { cancellationRequestedAt: new Date(), currentActivity: "Cancellation requested; waiting for worker confirmation." },
  });
  await appendExecutionEvent(runId, {
    phase: "waiting_for_worker",
    source: "web",
    severity: "warning",
    message: "Cancellation requested by Osman. Worker must confirm before the run is considered stopped.",
    meaningful: true,
    status: "running",
  });
  return getExecutionRun(userId, runId);
}

export async function shouldCancelRun(runId: string): Promise<boolean> {
  await ensureExecutionRunTables();
  const row = await prisma.executionRun.findUnique({ where: { id: runId }, select: { cancellationRequestedAt: true, status: true } }).catch(() => null);
  return Boolean(row?.cancellationRequestedAt && !["completed", "failed", "cancelled"].includes(row.status));
}

export async function createRetryRun(userId: string, runId: string): Promise<ExecutionRunView | null> {
  const original = await getExecutionRun(userId, runId);
  if (!original) return null;
  let taskId: string | null = null;
  if (original.taskId) {
    const oldTask = await getExecutionQueueTask(userId, original.taskId).catch(() => null);
    if (oldTask) {
      const task = await createExecutionQueueTask({
        userId,
        title: `Retry: ${oldTask.title}`.slice(0, 200),
        description: oldTask.description,
        priority: "high",
        assignedExecutor: original.executor === "hermes_agent" ? "hermes_agent" : "local_worker",
        projectId: original.projectId,
        initialLog: `Retry requested from run ${original.id}. No deploy, push, or production action was triggered.`,
      });
      taskId = task.id;
    }
  }
  return createExecutionRun({
    userId,
    projectId: original.projectId,
    taskId,
    parentRunId: original.id,
    executor: original.executor,
    currentPhase: "queued",
    currentActivity: `Retry queued from run ${original.id.slice(0, 8)}.`,
    localFolderPath: original.localFolderPath,
  });
}

export async function requestCodexFallback(userId: string, runId: string, confirmation: string | null): Promise<ExecutionRunView | null> {
  if (confirmation !== "switch-to-codex") throw new Error("Explicit confirmation is required.");
  const original = await getExecutionRun(userId, runId);
  if (!original) return null;
  let taskId: string | null = null;
  if (original.taskId) {
    const oldTask = await getExecutionQueueTask(userId, original.taskId).catch(() => null);
    if (oldTask) {
      const task = await createExecutionQueueTask({
        userId,
        title: `Codex fallback: ${oldTask.title}`.slice(0, 200),
        description: oldTask.description,
        priority: "high",
        assignedExecutor: "local_worker",
        projectId: original.projectId,
        initialLog: `Explicit Codex fallback requested from run ${original.id}. No deploy, push, or production action was triggered.`,
      });
      taskId = task.id;
    }
  }
  await appendExecutionEvent(original.id, {
    phase: "codex_fallback_running",
    source: "web",
    severity: "warning",
    message: "Osman explicitly requested Switch to Codex. A separate Codex/local-worker run was queued.",
    safeDetails: { newTaskId: taskId },
  });
  return createExecutionRun({
    userId,
    projectId: original.projectId,
    taskId,
    parentRunId: original.id,
    executor: "codex_cli",
    currentPhase: "queued",
    currentActivity: "Codex fallback queued after explicit confirmation.",
    localFolderPath: original.localFolderPath,
    fallbackReason: `Manual fallback from ${original.id}`,
  });
}

export async function markStalledRuns(userId?: string): Promise<number> {
  await ensureExecutionRunTables();
  const cutoff = new Date(Date.now() - 180_000);
  const warnCutoff = new Date(Date.now() - 90_000);
  const heartbeatCutoff = new Date(Date.now() - 90_000);
  const where = {
    ...(userId ? { userId } : {}),
    status: { in: ["queued", "running"] },
    currentPhase: { notIn: ["waiting_for_worker", "waiting_for_approval"] },
  };
  const warningRows = await prisma.executionRun.findMany({
    where: { ...where, lastMeaningfulEventAt: { lt: warnCutoff, gte: cutoff } },
    take: 20,
  }).catch(() => []);
  for (const run of warningRows) {
    const existing = await prisma.executionTraceEvent.findFirst({
      where: { runId: run.id, phase: run.currentPhase, severity: "warning", message: { contains: "No meaningful progress" } },
      orderBy: { createdAt: "desc" },
    }).catch(() => null);
    if (!existing) {
      await appendExecutionEvent(run.id, {
        phase: run.currentPhase as ExecutionPhase,
        source: "web",
        severity: "warning",
        message: "No meaningful progress event for 90 seconds. Heartbeats may still be active.",
        meaningful: false,
      });
    }
  }
  const stalled = await prisma.executionRun.findMany({
    where: { ...where, lastMeaningfulEventAt: { lt: cutoff }, lastHeartbeatAt: { lt: heartbeatCutoff } },
    take: 50,
  }).catch(() => []);
  for (const run of stalled) {
    await appendExecutionEvent(run.id, {
      phase: "stalled",
      source: "web",
      severity: "warning",
      message: "Run marked stalled after 3 minutes without a meaningful event.",
      meaningful: true,
      status: "stalled",
    });
  }
  return stalled.length;
}
