import { createClient, type Client } from "@libsql/client";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
// Dependency-free on purpose — safe to import before loadLocalEnv() runs,
// unlike ../src/lib/local-builder which is only ever imported dynamically.
import { parseHermesChatOutput, sanitizeHermesOutput } from "../src/lib/hermes-nous-cli";
import { councilProviderEntries, formatCouncilResponse, getCouncilProvider, runCouncilProvider, type CouncilChatMode } from "../src/lib/council-providers";
import type { ProviderFamily } from "../src/lib/model-provider-registry";
import { DEFAULT_LOCAL_PROJECTS_ROOT, resolveLocalProjectsRoot } from "../src/lib/local-projects-root";

type QueueTask = {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: string;
  projectId: string | null;
  logs: string | null;
  assignedExecutor: string;
  runId?: string | null;
};

type ExecutionPhase =
  | "queued" | "claimed" | "initializing" | "planning" | "fugu_design_gate"
  | "waiting_for_worker" | "waiting_for_approval" | "preparing_workspace"
  | "hermes_nous_running" | "codex_fallback_running" | "installing_dependencies"
  | "building" | "starting_preview" | "browser_qa" | "fugu_polish_review"
  | "completed" | "failed" | "cancelled" | "stalled";

type ExecutionSource = "web" | "local_worker" | "hermes_nous" | "codex" | "fugu" | "qa";
type ExecutionSeverity = "info" | "warning" | "error";

type WorkerCapabilities = {
  nodeVersion: string;
  npmVersion: string | null;
  gitAvailable: boolean;
  codexAvailable: boolean;
  hermesAgentAvailable: boolean;
  hermesAgentPath: string | null;
  hermesAgentVersion: string | null;
  hermesAgentAuthConfigured: boolean;
  hermesAgentModelConfigured: boolean;
};

const execFileAsync = promisify(execFile);
const POLL_MS = Number(process.env.HERMES_LOCAL_WORKER_POLL_MS ?? 15_000);
const HEARTBEAT_MS = Number(process.env.HERMES_LOCAL_WORKER_HEARTBEAT_MS ?? 15_000);
const LEASE_MS = 5 * 60_000;
const WORKER_ID = process.env.HERMES_LOCAL_WORKER_ID?.trim() || `local-worker:${os.hostname()}:${process.pid}`;
const ALLOWED_ACTIONS = new Set(["prepare", "generate", "runQa", "rebuild", "build", "npmBuild", "startDev", "stopDev"]);

let currentTask: string | null = null;
let lastError: string | null = null;
let lastFetchError: string | null = null;
let lastHermesAgentRun: string | null = null;
let lastHermesAgentError: string | null = null;

// The always-on laptop supplies the polling frequency that Vercel's
// once-daily email-watcher cron can't. The route does the actual triage and
// already dedupes per email (4h window), so frequent calls are safe.
const EMAIL_POLL_DEFAULT_MS = 3 * 60_000;
let lastEmailPoll = 0;
let emailPollInFlight = false;

class CancellationRequestedError extends Error {
  constructor() {
    super("Cancellation confirmed by local worker.");
    this.name = "CancellationRequestedError";
  }
}

// Read lazily (not at module load) — CRON_SECRET and the override come from
// .env.local, which loadLocalEnv() only applies once runLoop() starts.
function emailPollIntervalMs(): number {
  const raw = process.env.HERMES_WORKER_EMAIL_POLL_MS?.trim();
  if (!raw) return EMAIL_POLL_DEFAULT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : EMAIL_POLL_DEFAULT_MS;
}

async function maybePollEmailWatcher(apiBaseUrl: string): Promise<void> {
  const interval = emailPollIntervalMs();
  if (interval === 0) return; // HERMES_WORKER_EMAIL_POLL_MS=0 disables the poll
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return;
  const now = Date.now();
  if (emailPollInFlight || now - lastEmailPoll < interval) return;
  emailPollInFlight = true;
  lastEmailPoll = now;
  try {
    const response = await fetch(new URL("/api/cron/email-watcher", apiBaseUrl), {
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(55_000),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as { notified?: string[] } | null;
    if (!response.ok) {
      console.error(`Email poll failed: HTTP ${response.status} ${response.statusText}`.trim());
    } else if (payload?.notified?.length) {
      console.log(`Email poll: ${payload.notified.length} action-needed email(s) notified.`);
    }
  } catch (error) {
    console.error(`Email poll failed: ${safeError(error)}`);
  } finally {
    emailPollInFlight = false;
  }
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadLocalEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
  process.env.HERMES_LOCAL_PROJECTS_ROOT = process.env.HERMES_LOCAL_PROJECTS_ROOT?.trim() || DEFAULT_LOCAL_PROJECTS_ROOT;
}

function normalizeBaseUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const url = new URL(withProtocol);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

function workerApiBaseUrl(): string {
  for (const value of [process.env.HERMES_WORKER_API_BASE_URL, process.env.NEXT_PUBLIC_APP_URL, process.env.VERCEL_URL]) {
    if (!value) continue;
    const normalized = normalizeBaseUrl(value);
    if (normalized) return normalized;
  }
  return "http://localhost:3000";
}

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: string } | undefined;
  return error instanceof TypeError || Boolean(cause?.code && /^(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_)/.test(cause.code));
}

async function checkWorkerApi(baseUrl: string): Promise<void> {
  const targetUrl = new URL("/api/worker/health", baseUrl).toString();
  try {
    const response = await fetch(targetUrl, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    lastFetchError = null;
  } catch (error) {
    lastFetchError = safeError(error);
    console.error(`Worker API fetch failed. Target URL: ${targetUrl}; Status/Error: ${lastFetchError}; DNS/network failed: ${networkFailure(error) ? "yes" : "no"}`);
    throw error;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Hermes Local Worker.`);
  return value;
}

function createDb(): Client {
  return createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function parseLogs(value: string | null): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    return value.split(/\r?\n/).filter(Boolean);
  }
  return [];
}

function appendLog(existing: string | null, message: string): string {
  const logs = parseLogs(existing);
  logs.push(`${new Date().toISOString()} ${message}`);
  return JSON.stringify(logs.slice(-120));
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(TURSO_AUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|SAKANA_API_KEY|FIRECRAWL_API_KEY|SERPAPI_API_KEY|AMADEUS_CLIENT_SECRET)=\S+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(postgres|mysql|libsql|mongodb|redis):\/\/[^\s"'<>]+/gi, "[redacted-connection-string]")
    .replace(/(?:^|\s)(?:sk|pk|ghp|gho|ghu|ghs|xoxb)-[A-Za-z0-9_-]{12,}/gi, " [redacted-token]")
    .replace(/\.env(?:\.[A-Za-z0-9_-]+)?/g, "[env-file]")
    .slice(0, 2000);
}

function safeTraceText(value: unknown, max = 2000): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return safeError(raw).slice(0, max);
}

function safeTraceDetails(details?: Record<string, unknown>): string | null {
  if (!details) return null;
  const safe = Object.fromEntries(Object.entries(details).slice(0, 30).map(([key, value]) => [
    safeTraceText(key, 80),
    typeof value === "number" || typeof value === "boolean" || value === null
      ? value
      : safeTraceText(value, 500),
  ]));
  return JSON.stringify(safe).slice(0, 4000);
}

function terminalStatusForPhase(phase: ExecutionPhase): string | null {
  if (phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "stalled") return phase;
  return null;
}

function executorForTask(task: QueueTask): string {
  if (task.assignedExecutor === "hermes_agent") return "hermes_agent";
  if (task.assignedExecutor === "codex_cli") return "codex_cli";
  return "local_worker";
}

async function ensureExecutionRunTables(db: Client): Promise<void> {
  await db.execute(`
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
  await db.execute(`
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
  await db.execute(`CREATE INDEX IF NOT EXISTS ExecutionRun_taskId_idx ON ExecutionRun(taskId)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS ExecutionRun_userId_startedAt_idx ON ExecutionRun(userId, startedAt)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS ExecutionTraceEvent_runId_createdAt_idx ON ExecutionTraceEvent(runId, createdAt)`);
}

async function ensureExecutionRunForTask(db: Client, task: QueueTask): Promise<string> {
  await ensureExecutionRunTables(db);
  const existing = await db.execute({
    sql: `SELECT id FROM ExecutionRun WHERE taskId = ? ORDER BY startedAt DESC LIMIT 1`,
    args: [task.id],
  });
  const existingId = String((existing.rows[0] as Record<string, unknown> | undefined)?.id ?? "");
  if (existingId) return existingId;

  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO ExecutionRun (id, userId, projectId, taskId, executor, currentPhase, currentActivity, status, workerId, startedAt, lastHeartbeatAt, lastMeaningfulEventAt, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, 'queued', ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'), datetime('now'))`,
    args: [id, task.userId, task.projectId, task.id, executorForTask(task), `Queued for ${task.assignedExecutor}.`, WORKER_ID],
  });
  await db.execute({
    sql: `INSERT INTO ExecutionTraceEvent (id, runId, phase, severity, message, source, safeDetails, createdAt)
          VALUES (?, ?, 'queued', 'info', ?, 'local_worker', NULL, datetime('now'))`,
    args: [crypto.randomUUID(), id, `Run discovered by ${WORKER_ID}.`],
  });
  return id;
}

async function traceEvent(db: Client, task: QueueTask, params: {
  phase: ExecutionPhase;
  source?: ExecutionSource;
  severity?: ExecutionSeverity;
  message: string;
  details?: Record<string, unknown>;
  meaningful?: boolean;
  status?: string;
  localFolderPath?: string | null;
  lastSafeError?: string | null;
}): Promise<void> {
  const runId = task.runId || await ensureExecutionRunForTask(db, task);
  task.runId = runId;
  const message = safeTraceText(params.message, 700);
  const terminal = terminalStatusForPhase(params.phase);
  await db.execute({
    sql: `INSERT INTO ExecutionTraceEvent (id, runId, phase, severity, message, source, safeDetails, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      crypto.randomUUID(),
      runId,
      params.phase,
      params.severity ?? "info",
      message,
      params.source ?? "local_worker",
      safeTraceDetails(params.details),
    ],
  });
  await db.execute({
    sql: `UPDATE ExecutionRun
          SET currentPhase = ?, currentActivity = ?, status = ?,
              lastHeartbeatAt = datetime('now'),
              lastMeaningfulEventAt = CASE WHEN ? = 1 THEN datetime('now') ELSE lastMeaningfulEventAt END,
              completedAt = CASE WHEN ? = 1 THEN datetime('now') ELSE completedAt END,
              workerId = ?, localFolderPath = coalesce(?, localFolderPath),
              lastSafeError = coalesce(?, lastSafeError), updatedAt = datetime('now')
          WHERE id = ?`,
    args: [
      params.phase,
      message,
      params.status ?? terminal ?? "running",
      params.meaningful === false ? 0 : 1,
      terminal ? 1 : 0,
      WORKER_ID,
      params.localFolderPath ?? null,
      params.lastSafeError ? safeTraceText(params.lastSafeError, 1000) : null,
      runId,
    ],
  });
}

async function heartbeatExecutionRun(db: Client, task: QueueTask, activity?: string): Promise<void> {
  if (!task.runId) return;
  await db.execute({
    sql: `UPDATE ExecutionRun SET lastHeartbeatAt = datetime('now'), workerId = ?, currentActivity = coalesce(?, currentActivity), updatedAt = datetime('now') WHERE id = ?`,
    args: [WORKER_ID, activity ? safeTraceText(activity, 700) : null, task.runId],
  }).catch(() => undefined);
}

async function isCancellationRequested(db: Client, task: QueueTask): Promise<boolean> {
  if (!task.runId) return false;
  const res = await db.execute({
    sql: `SELECT cancellationRequestedAt, status FROM ExecutionRun WHERE id = ? LIMIT 1`,
    args: [task.runId],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return Boolean(row?.cancellationRequestedAt && !["completed", "failed", "cancelled"].includes(String(row.status ?? "")));
}

async function throwIfCancellationRequested(db: Client, task: QueueTask): Promise<void> {
  if (!await isCancellationRequested(db, task)) return;
  await traceEvent(db, task, {
    phase: "cancelled",
    source: "local_worker",
    severity: "warning",
    message: "Cancellation confirmed by local worker.",
    status: "cancelled",
  });
  await updateTask(db, task, { status: "cancelled", result: "Cancellation confirmed by local worker.", error: null, log: "Cancelled after Osman requested cancellation." }).catch(() => undefined);
  throw new CancellationRequestedError();
}

async function ensureWorkerTables(db: Client): Promise<void> {
  await ensureExecutionRunTables(db);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS LocalWorkerHeartbeat (
      workerId TEXT PRIMARY KEY,
      machineName TEXT NOT NULL,
      status TEXT NOT NULL,
      lastHeartbeat TEXT NOT NULL,
      rootPath TEXT NOT NULL,
      nodeVersion TEXT,
      npmVersion TEXT,
      gitAvailable INTEGER NOT NULL DEFAULT 0,
      codexAvailable INTEGER NOT NULL DEFAULT 0,
      currentTask TEXT,
      lastError TEXT,
      workerApiTarget TEXT,
      lastFetchError TEXT,
      hermesAgentAvailable INTEGER NOT NULL DEFAULT 0,
      hermesAgentPath TEXT,
      hermesAgentVersion TEXT,
      hermesAgentAuthConfigured INTEGER NOT NULL DEFAULT 0,
      hermesAgentModelConfigured INTEGER NOT NULL DEFAULT 0,
      lastHermesAgentRun TEXT,
      lastHermesAgentError TEXT,
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN workerApiTarget TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN lastFetchError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN hermesAgentAvailable INTEGER NOT NULL DEFAULT 0`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN hermesAgentPath TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN hermesAgentVersion TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN hermesAgentAuthConfigured INTEGER NOT NULL DEFAULT 0`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN hermesAgentModelConfigured INTEGER NOT NULL DEFAULT 0`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN lastHermesAgentRun TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE LocalWorkerHeartbeat ADD COLUMN lastHermesAgentError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN claimed_by_worker_id TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN lease_expires_at TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE AgentTask ADD COLUMN claimed_at TEXT`).catch(() => undefined);
}

async function recoverStaleTasks(db: Client): Promise<number> {
  const stale = await db.execute({
    sql: `SELECT id, logs FROM AgentTask
          WHERE status = 'executing'
            AND assigned_executor IN ('local_worker', 'hermes_agent', 'hermes_chat', 'council_chat')
            AND (lease_expires_at < datetime('now')
              OR (lease_expires_at IS NULL AND updatedAt < datetime('now', '-5 minutes')))`,
    args: [],
  });
  let recovered = 0;
  for (const row of stale.rows as Array<Record<string, unknown>>) {
    const id = String(row.id ?? "");
    if (!id) continue;
    const update = await db.execute({
      sql: `UPDATE AgentTask
            SET status = 'queued', claimed_by_worker_id = NULL, lease_expires_at = NULL,
                claimed_at = NULL, logs = ?, updatedAt = datetime('now')
            WHERE id = ? AND status = 'executing'
              AND (lease_expires_at < datetime('now')
                OR (lease_expires_at IS NULL AND updatedAt < datetime('now', '-5 minutes')))`,
      args: [appendLog(typeof row.logs === "string" ? row.logs : null, "Recovered after worker lease expired."), id],
    });
    recovered += update.rowsAffected;
  }
  if (recovered) console.warn(`Recovered ${recovered} stale executing task(s).`);
  return recovered;
}

async function renewTaskLease(db: Client, taskId: string): Promise<boolean> {
  const update = await db.execute({
    sql: `UPDATE AgentTask SET lease_expires_at = datetime('now', '+5 minutes'), updatedAt = datetime('now')
          WHERE id = ? AND status = 'executing' AND claimed_by_worker_id = ?`,
    args: [taskId, WORKER_ID],
  });
  return update.rowsAffected > 0;
}

async function commandAvailable(command: string, args: string[]): Promise<{ available: boolean; version: string | null }> {
  try {
    // Route through cmd.exe on Windows (same pattern as runNpm): npm and codex
    // are .cmd shims, which Node's execFile refuses to spawn without a shell —
    // detecting them directly always reported "unavailable".
    const isWindows = process.platform === "win32";
    const quote = (value: string) => (/[\s;]/.test(value) ? `"${value}"` : value);
    const executable = isWindows ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : command;
    const executableArgs = isWindows ? ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")] : args;
    const result = await execFileAsync(executable, executableArgs, {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 200_000,
    });
    const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0]?.trim() || null;
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

async function getCapabilities(): Promise<WorkerCapabilities> {
  const [npm, git, codex, hermesPath] = await Promise.all([
    commandAvailable("npm", ["--version"]),
    commandAvailable("git", ["--version"]),
    commandAvailable("codex", ["--version"]),
    commandAvailable("where.exe", ["hermes-agent"]),
  ]);
  const executablePath = hermesPath.version?.split(/\r?\n/)[0]?.trim() || null;
  const hermesPython = executablePath ? path.join(path.dirname(executablePath), "python.exe") : "python";
  const hermesVersion = executablePath
    ? await commandAvailable(hermesPython, ["-c", "import importlib.metadata; print(importlib.metadata.version('hermes-agent'))"])
    : { available: false, version: null };
  let hermesAgentAuthConfigured = false;
  let hermesAgentModelConfigured = false;
  if (executablePath) {
    const hermesCommand = path.join(path.dirname(executablePath), "hermes.exe");
    const command = existsSync(hermesCommand) ? hermesCommand : "hermes";
    const captureStatus = async (args: string[]): Promise<string> => {
      try {
        const result = await execFileAsync(command, args, { windowsHide: true, timeout: 20_000, maxBuffer: 200_000, env: hermesAgentProcessEnv() });
        return `${result.stdout}${result.stderr}`;
      } catch (error) {
        const result = error as { stdout?: string; stderr?: string };
        return `${result.stdout ?? ""}${result.stderr ?? ""}`;
      }
    };
    const [authText, modelText] = await Promise.all([captureStatus(["auth"]), captureStatus(["model"])]);
    hermesAgentAuthConfigured = /nous/i.test(authText) && /oauth/i.test(authText);
    hermesAgentModelConfigured = /(?:selected|current|active|provider|model)/i.test(modelText)
      && !/(?:not configured|none selected|missing)/i.test(modelText);
  }
  return {
    nodeVersion: process.version,
    npmVersion: npm.version,
    gitAvailable: git.available,
    codexAvailable: codex.available,
    hermesAgentAvailable: Boolean(executablePath),
    hermesAgentPath: executablePath,
    hermesAgentVersion: hermesVersion.version,
    hermesAgentAuthConfigured,
    hermesAgentModelConfigured,
  };
}

async function heartbeat(db: Client, capabilities: WorkerCapabilities, apiBaseUrl: string): Promise<void> {
  await ensureWorkerTables(db);
  try {
    await checkWorkerApi(apiBaseUrl);
  } catch (error) {
    lastError = lastFetchError ?? safeError(error);
    await db.execute({
      sql: `
        INSERT INTO LocalWorkerHeartbeat (
          workerId, machineName, status, lastHeartbeat, rootPath, nodeVersion, npmVersion,
          gitAvailable, codexAvailable, currentTask, lastError, workerApiTarget, lastFetchError,
          hermesAgentAvailable, hermesAgentPath, hermesAgentVersion, hermesAgentAuthConfigured,
          hermesAgentModelConfigured, lastHermesAgentRun, lastHermesAgentError, updatedAt
        ) VALUES (?, ?, 'offline', datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(workerId) DO UPDATE SET
          machineName = excluded.machineName,
          status = 'offline',
          rootPath = excluded.rootPath,
          lastError = excluded.lastError,
          workerApiTarget = excluded.workerApiTarget,
          lastFetchError = excluded.lastFetchError,
          hermesAgentAvailable = excluded.hermesAgentAvailable,
          hermesAgentPath = excluded.hermesAgentPath,
          hermesAgentVersion = excluded.hermesAgentVersion,
          hermesAgentAuthConfigured = excluded.hermesAgentAuthConfigured,
          hermesAgentModelConfigured = excluded.hermesAgentModelConfigured,
          lastHermesAgentRun = excluded.lastHermesAgentRun,
          lastHermesAgentError = excluded.lastHermesAgentError,
          updatedAt = datetime('now')
      `,
      args: [
        WORKER_ID, os.hostname(), resolveLocalProjectsRoot(),
        capabilities.nodeVersion, capabilities.npmVersion, capabilities.gitAvailable ? 1 : 0,
        capabilities.codexAvailable ? 1 : 0, currentTask, lastError, apiBaseUrl, lastFetchError,
        capabilities.hermesAgentAvailable ? 1 : 0, capabilities.hermesAgentPath, capabilities.hermesAgentVersion,
        capabilities.hermesAgentAuthConfigured ? 1 : 0, capabilities.hermesAgentModelConfigured ? 1 : 0,
        lastHermesAgentRun, lastHermesAgentError,
      ],
    }).catch(() => undefined);
    throw error;
  }
  await db.execute({
    sql: `
      INSERT INTO LocalWorkerHeartbeat (
        workerId, machineName, status, lastHeartbeat, rootPath, nodeVersion, npmVersion,
        gitAvailable, codexAvailable, currentTask, lastError, workerApiTarget, lastFetchError,
        hermesAgentAvailable, hermesAgentPath, hermesAgentVersion, hermesAgentAuthConfigured,
        hermesAgentModelConfigured, lastHermesAgentRun, lastHermesAgentError, updatedAt
      ) VALUES (?, ?, 'online', datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workerId) DO UPDATE SET
        machineName = excluded.machineName,
        status = 'online',
        lastHeartbeat = excluded.lastHeartbeat,
        rootPath = excluded.rootPath,
        nodeVersion = excluded.nodeVersion,
        npmVersion = excluded.npmVersion,
        gitAvailable = excluded.gitAvailable,
        codexAvailable = excluded.codexAvailable,
        currentTask = excluded.currentTask,
        lastError = excluded.lastError,
        workerApiTarget = excluded.workerApiTarget,
        lastFetchError = excluded.lastFetchError,
        hermesAgentAvailable = excluded.hermesAgentAvailable,
        hermesAgentPath = excluded.hermesAgentPath,
        hermesAgentVersion = excluded.hermesAgentVersion,
        hermesAgentAuthConfigured = excluded.hermesAgentAuthConfigured,
        hermesAgentModelConfigured = excluded.hermesAgentModelConfigured,
        lastHermesAgentRun = excluded.lastHermesAgentRun,
        lastHermesAgentError = excluded.lastHermesAgentError,
        updatedAt = datetime('now')
    `,
    args: [
      WORKER_ID,
      os.hostname(),
      resolveLocalProjectsRoot(),
      capabilities.nodeVersion,
      capabilities.npmVersion,
      capabilities.gitAvailable ? 1 : 0,
      capabilities.codexAvailable ? 1 : 0,
      currentTask,
      lastError,
      apiBaseUrl,
      lastFetchError,
      capabilities.hermesAgentAvailable ? 1 : 0,
      capabilities.hermesAgentPath,
      capabilities.hermesAgentVersion,
      capabilities.hermesAgentAuthConfigured ? 1 : 0,
      capabilities.hermesAgentModelConfigured ? 1 : 0,
      lastHermesAgentRun,
      lastHermesAgentError,
    ],
  });
}

async function markWorkerOffline(db: Client, capabilities: WorkerCapabilities, apiBaseUrl: string): Promise<void> {
  await db.execute({
    sql: `UPDATE LocalWorkerHeartbeat SET status = 'offline', currentTask = NULL, lastError = ?, updatedAt = datetime('now') WHERE workerId = ?`,
    args: [lastError ?? "Worker stopped.", WORKER_ID],
  }).catch(async () => heartbeat(db, capabilities, apiBaseUrl).catch(() => undefined));
}

async function claimTask(db: Client): Promise<QueueTask | null> {
  const res = await db.execute({
    sql: `
      SELECT id, userId, title, description, status, project_id, logs, assigned_executor
      FROM AgentTask
      WHERE assigned_executor IN ('local_worker', 'hermes_agent', 'hermes_chat', 'council_chat') AND status = 'queued'
      ORDER BY createdAt ASC
      LIMIT 1
    `,
    args: [],
  });
  if (!res.rows.length) return null;

  const row = res.rows[0] as Record<string, unknown>;
  const task: QueueTask = {
    id: String(row.id ?? ""),
    userId: String(row.userId ?? ""),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    status: String(row.status ?? ""),
    projectId: typeof row.project_id === "string" && row.project_id.trim() ? row.project_id : null,
    logs: typeof row.logs === "string" ? row.logs : null,
    assignedExecutor: String(row.assigned_executor ?? "local_worker"),
  };

  const update = await db.execute({
    sql: `
      UPDATE AgentTask
      SET status = 'executing', claimed_by_worker_id = ?, claimed_at = datetime('now'),
          lease_expires_at = datetime('now', '+5 minutes'), logs = ?, updatedAt = datetime('now')
      WHERE id = ? AND status = 'queued' AND assigned_executor = ?
    `,
    args: [WORKER_ID, appendLog(task.logs, `Claimed by local worker ${WORKER_ID} for ${task.assignedExecutor}; lease ${LEASE_MS / 60_000} minutes.`), task.id, task.assignedExecutor],
  });

  if (update.rowsAffected <= 0) return null;
  task.runId = await ensureExecutionRunForTask(db, task);
  await traceEvent(db, task, {
    phase: "claimed",
    source: "local_worker",
    message: `Claimed by ${WORKER_ID}.`,
    details: { executor: task.assignedExecutor, taskId: task.id, projectId: task.projectId },
  });
  return task;
}

async function updateTask(db: Client, task: QueueTask, params: { status?: string; result?: string | null; error?: string | null; log?: string; files?: string[] }): Promise<void> {
  const current = await db.execute({ sql: `SELECT logs FROM AgentTask WHERE id = ? LIMIT 1`, args: [task.id] });
  const existingLogs = typeof (current.rows[0] as Record<string, unknown> | undefined)?.logs === "string"
    ? String((current.rows[0] as Record<string, unknown>).logs)
    : task.logs;
  const fields: string[] = [];
  const args: (string | null)[] = [];
  if (params.status) {
    fields.push("status = ?");
    args.push(params.status);
    if (params.status !== "executing") {
      fields.push("claimed_by_worker_id = NULL", "lease_expires_at = NULL", "claimed_at = NULL");
    }
  }
  if (params.result !== undefined) {
    fields.push("result = ?");
    args.push(params.result ? params.result.slice(0, 2000) : null);
  }
  if (params.error !== undefined) {
    fields.push("error = ?");
    args.push(params.error ? params.error.slice(0, 1000) : null);
  }
  if (params.log) {
    fields.push("logs = ?");
    args.push(appendLog(existingLogs, params.log));
  }
  if (params.files) {
    fields.push("files = ?");
    args.push(JSON.stringify(params.files.slice(0, 200)));
  }
  if (!fields.length) return;
  fields.push("updatedAt = datetime('now')");
  args.push(task.id);
  await db.execute({ sql: `UPDATE AgentTask SET ${fields.join(", ")} WHERE id = ? AND claimed_by_worker_id = ?`, args: [...args, WORKER_ID] });
}

async function updateProjectExecuting(db: Client, task: QueueTask, action: string): Promise<void> {
  if (!task.projectId) return;
  await db.execute({
    sql: `
      UPDATE Project
      SET status = 'executing_on_local_worker',
          assignedAgent = ?,
          localBuildLog = substr(coalesce(localBuildLog, '') || char(10) || ?, -12000),
          localBuildError = NULL,
          updatedAt = datetime('now')
      WHERE id = ? AND userId = ?
    `,
    args: [task.assignedExecutor, `Local Worker ${WORKER_ID} started ${action}.`, task.projectId, task.userId],
  }).catch(() => undefined);
}

function parseTaskPayload(task: QueueTask): { action: string; message: string } {
  const action = task.description.match(/^Action:\s*(.+)$/m)?.[1]?.trim() || "prepare";
  const message = task.description.match(/^Message:\s*([\s\S]*?)(?:\nRun this from|\n[A-Z][A-Za-z ]+:|$)/m)?.[1]?.trim() || task.title;
  return { action, message };
}

function taskStatusForProjectStatus(status: string): "completed" | "failed" | "qa_pending" | "qa_passed" {
  if (status === "qa_pending" || status === "Build Passed") return "qa_pending";
  if (status === "qa_passed" || status === "completed") return "qa_passed";
  if (/failed|Build Failed|qa_failed/i.test(status)) return "failed";
  return "completed";
}

function hermesAgentProcessEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "HERMES_HOME", "HERMES_GIT_BASH_PATH",
  ];
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    TERMINAL_ENV: "local",
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
  };
}

function safeHermesOutput(value: string): string {
  return sanitizeHermesOutput(value);
}

function parseHermesChatPayload(task: QueueTask): { message: string; chatMessageId: string | null; hermesSessionId: string | null } {
  try {
    const parsed = JSON.parse(task.description) as { message?: unknown; chatMessageId?: unknown; hermesSessionId?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    if (!message) throw new Error("Hermes Nous chat task is missing a message.");
    return {
      message,
      chatMessageId: typeof parsed.chatMessageId === "string" && parsed.chatMessageId.trim() ? parsed.chatMessageId : null,
      hermesSessionId: typeof parsed.hermesSessionId === "string" && parsed.hermesSessionId.trim() ? parsed.hermesSessionId : null,
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Hermes Nous chat task payload is not valid JSON.");
    throw error;
  }
}

function parseCouncilChatPayload(task: QueueTask): {
  mode: CouncilChatMode;
  providerFamily: ProviderFamily | null;
  target: string;
  message: string;
  chatMessageId: string | null;
} {
  try {
    const parsed = JSON.parse(task.description) as {
      mode?: unknown;
      providerFamily?: unknown;
      target?: unknown;
      message?: unknown;
      chatMessageId?: unknown;
    };
    const mode: CouncilChatMode = parsed.mode === "provider" ? "provider" : "council";
    const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
    const target = typeof parsed.target === "string" && parsed.target.trim() ? parsed.target.trim() : "model_council";
    if (!message) throw new Error("Council chat task is missing a message.");
    return {
      mode,
      providerFamily: typeof parsed.providerFamily === "string" && parsed.providerFamily.trim()
        ? parsed.providerFamily as ProviderFamily
        : null,
      target,
      message,
      chatMessageId: typeof parsed.chatMessageId === "string" && parsed.chatMessageId.trim() ? parsed.chatMessageId : null,
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Council chat task payload is not valid JSON.");
    throw error;
  }
}

async function ensureHermesNousChatSessionTable(db: Client): Promise<void> {
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

async function assertSafeHermesProjectFolder(folder: string): Promise<string> {
  const root = path.resolve(resolveLocalProjectsRoot());
  const resolved = path.resolve(folder);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved === root || !resolved.startsWith(rootWithSep)) {
    throw new Error("Hermes Agent refused to operate outside a HermesProject project folder.");
  }
  const parawiRoot = path.resolve(process.cwd());
  if (resolved === parawiRoot || resolved.startsWith(`${parawiRoot}${path.sep}`)) {
    throw new Error("Hermes Agent cannot modify the main Parawi repository without explicit approval.");
  }
  await mkdir(resolved, { recursive: true });
  const folderStat = await stat(resolved);
  if (!folderStat.isDirectory()) throw new Error("Hermes Agent project path is not a directory.");
  return resolved;
}

async function listDirectories(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      // .next is regenerated build output — hash-named folders vanish on every
      // rebuild and must not trip the deleted-folder safety check.
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
      const full = path.join(folder, entry.name);
      found.add(path.relative(root, full));
      await walk(full);
    }
  }
  await walk(root);
  return found;
}

async function listReportableFiles(root: string, folder = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await listReportableFiles(root, full));
    else if (entry.isFile() && !entry.name.startsWith("HERMES_AGENT_TASK_")) files.push(path.relative(root, full).replaceAll("\\", "/"));
  }
  return files.sort();
}

async function runNpm(folder: string, args: string[], timeout: number): Promise<string> {
  const command = ["npm", ...args].join(" ");
  const result = await execFileAsync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], {
    cwd: folder,
    windowsHide: true,
    timeout,
    maxBuffer: 2_000_000,
    env: hermesAgentProcessEnv(),
  });
  return safeHermesOutput(`${result.stdout}${result.stderr}`.trim());
}

async function verifyParawiLocalAppContract(folder: string): Promise<void> {
  const packagePath = path.join(folder, "package.json");
  let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8")) as typeof packageJson;
  } catch {
    throw new Error("Wrong framework: expected Next.js App Router.");
  }
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const requiredFiles = ["src/app/page.tsx", "src/app/layout.tsx", "src/app/globals.css"];
  const forbiddenFiles = ["index.html", "vite.config.js", "vite.config.ts", "vite.config.mjs", "src/main.js", "src/main.ts", "src/main.jsx", "src/main.tsx"];
  const valid = Boolean(dependencies.next && dependencies.react && dependencies["react-dom"])
    && packageJson.scripts?.build === "next build"
    && requiredFiles.every((file) => existsSync(path.join(folder, ...file.split("/"))))
    && forbiddenFiles.every((file) => !existsSync(path.join(folder, ...file.split("/"))))
    && !dependencies.vite
    && !dependencies["react-scripts"];
  if (!valid) throw new Error("Wrong framework: expected Next.js App Router.");
}

async function executeHermesAgentTask(db: Client, task: QueueTask, capabilities: WorkerCapabilities): Promise<void> {
  if (!task.projectId) throw new Error("Hermes Agent tasks require a project id.");
  if (/ForceHermesNousFailureForVerifier:\s*true/i.test(task.description)) {
    await traceEvent(db, task, {
      phase: "hermes_nous_running",
      source: "hermes_nous",
      severity: "warning",
      message: "Verifier forced Hermes Nous failure before CLI execution.",
      details: { commandCategory: "verifier_forced_hermes_failure" },
    });
    throw new Error("Forced Hermes Nous verifier failure.");
  }
  if (!capabilities.hermesAgentAvailable || !capabilities.hermesAgentPath) {
    throw new Error("Hermes Agent is not installed or is unavailable on the Local Worker machine.");
  }
  if (!capabilities.hermesAgentAuthConfigured || !capabilities.hermesAgentModelConfigured) {
    throw new Error("Hermes Agent is not ready: run `hermes auth` and `hermes model` on the Local Worker machine.");
  }

  const builder = await import("../src/lib/local-builder");
  await traceEvent(db, task, { phase: "planning", source: "local_worker", message: "Building Hermes Nous execution packet." });
  const packet = await builder.buildHermesAgentExecutionPrompt(task.userId, task.projectId, task.description);
  await traceEvent(db, task, { phase: "fugu_design_gate", source: "fugu", message: "Fugu design gate context prepared for Hermes Nous." });
  const folder = await assertSafeHermesProjectFolder(packet.folder);
  await traceEvent(db, task, {
    phase: "preparing_workspace",
    source: "local_worker",
    message: "Prepared safe local workspace for Hermes Nous.",
    localFolderPath: folder,
    details: { commandCategory: "workspace_prepare", projectId: task.projectId },
  });
  await throwIfCancellationRequested(db, task);
  const beforeDirectories = await listDirectories(folder);
  const promptName = `HERMES_AGENT_TASK_${task.id}.md`;
  const promptPath = path.join(folder, promptName);
  await writeFile(promptPath, packet.prompt, { encoding: "utf8", flag: "wx" });

  currentTask = `hermes_agent: ${task.title}`;
  lastHermesAgentRun = new Date().toISOString();
  lastHermesAgentError = null;
  await updateTask(db, task, { log: `Launching Hermes Agent ${capabilities.hermesAgentVersion ?? "unknown version"} in ${folder}.` });
  await updateProjectExecuting(db, task, "hermes_agent");
  await traceEvent(db, task, {
    phase: "hermes_nous_running",
    source: "hermes_nous",
    message: "Hermes Nous started.",
    details: { commandCategory: "hermes_oneshot", version: capabilities.hermesAgentVersion ?? "unknown" },
    localFolderPath: folder,
  });

  let agentOutput = "";
  try {
    const hermesCommand = path.join(path.dirname(capabilities.hermesAgentPath), "hermes.exe");
    try {
      const result = await execFileAsync(existsSync(hermesCommand) ? hermesCommand : "hermes", [
        "--oneshot",
        `Read the execution packet at ./${promptName} and execute it completely. Use the configured current directory; do not search outside it or ask for confirmation.`,
      ], {
        cwd: folder,
        windowsHide: true,
        timeout: Number(process.env.HERMES_AGENT_TIMEOUT_MS ?? 20 * 60_000),
        maxBuffer: 2_000_000,
        env: hermesAgentProcessEnv(),
      });
      agentOutput = safeHermesOutput(`${result.stdout}${result.stderr}`.trim());
      await traceEvent(db, task, {
        phase: "hermes_nous_running",
        source: "hermes_nous",
        message: "Hermes Nous response received.",
        details: { outputTail: agentOutput.slice(-1200) },
      });
    } catch (error) {
      const processError = error as Error & { stdout?: string; stderr?: string };
      const detail = safeHermesOutput(`${processError.stdout ?? ""}\n${processError.stderr ?? ""}`.trim());
      await traceEvent(db, task, {
        phase: "hermes_nous_running",
        source: "hermes_nous",
        severity: "error",
        message: "Hermes Nous returned an error.",
        details: { outputTail: detail.slice(-1200) },
        lastSafeError: detail || safeError(error),
      });
      throw new Error(detail || safeError(error));
    }
  } finally {
    await rm(promptPath, { force: true }).catch(() => undefined);
  }

  const afterDirectories = await listDirectories(folder);
  const deletedDirectories = [...beforeDirectories].filter((item) => !afterDirectories.has(item));
  if (deletedDirectories.length) throw new Error(`Hermes Agent safety check failed: deleted folder(s): ${deletedDirectories.slice(0, 8).join(", ")}`);

  await updateTask(db, task, { log: "Hermes Agent finished editing; verifying the app contract and generated files." });
  if (packet.requiresNextContract) await verifyParawiLocalAppContract(folder);
  const filesCreated = await listReportableFiles(folder);
  await updateTask(db, task, { files: filesCreated, log: `Files created or updated: ${filesCreated.length}.` });

  const packagePath = path.join(folder, "package.json");
  let buildOutput = "No package.json found; npm build skipped.";
  if (existsSync(packagePath)) {
    await updateTask(db, task, { log: "Dependencies install started." });
    await traceEvent(db, task, { phase: "installing_dependencies", source: "local_worker", message: "Dependency install started.", details: { commandCategory: "package_install" } });
    await throwIfCancellationRequested(db, task);
    const installOutput = existsSync(path.join(folder, "node_modules")) ? "Dependencies already present." : await runNpm(folder, ["install"], 10 * 60_000);
    await updateTask(db, task, { log: "Dependencies installed successfully." });
    await updateTask(db, task, { log: "npm run build started." });
    await traceEvent(db, task, { phase: "building", source: "local_worker", message: "Build started.", details: { commandCategory: "package_build" } });
    await throwIfCancellationRequested(db, task);
    const npmBuildOutput = await runNpm(folder, ["run", "build"], 10 * 60_000);
    await updateTask(db, task, { log: "npm run build passed." });
    buildOutput = `${installOutput}\n${npmBuildOutput}`.trim();
  }

  await db.execute({
    sql: `UPDATE Project SET status = 'qa_pending', assignedAgent = 'hermes_agent', localBuildLog = substr(coalesce(localBuildLog, '') || char(10) || ?, -12000), localBuildError = NULL, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
    args: [`Installing: passed\nBuilding: passed\n${buildOutput}`, task.projectId, task.userId],
  });

  await updateTask(db, task, { log: "Parawi QA checklist started." });
  await traceEvent(db, task, { phase: "browser_qa", source: "qa", message: "Parawi QA checklist started." });
  await throwIfCancellationRequested(db, task);
  await builder.runLocalBuilderQa(task.userId, task.projectId);
  await updateTask(db, task, { log: "Browser QA and preview startup started." });
  await traceEvent(db, task, { phase: "starting_preview", source: "local_worker", message: "Preview startup started." });
  const qa = await builder.startPreviewAndRunBrowserQa(task.userId, task.projectId);
  await traceEvent(db, task, { phase: "browser_qa", source: "qa", message: "Browser QA completed.", details: { qaStatus: qa.qaStatus, localDevUrl: qa.localDevUrl ?? "unavailable" } });
  const passed = qa.qaStatus === "qa_passed";
  await updateTask(db, task, { log: `Browser QA ${passed ? "passed" : "needs review"}; preview ${qa.localDevUrl ? "started" : "unavailable"}.` });
  const summary = [
    `Hermes Agent completed ${packet.projectName}.`,
    `Project name: ${packet.projectName}`,
    `App type: ${packet.appType}`,
    `Questions asked/answered: ${packet.questions.length ? packet.questions.join(" | ") : "none; request was sufficiently specific"}`,
    `Knowledge cards loaded: ${packet.cardsLoaded.join(", ") || "none"}`,
    `Folder: ${folder}`,
    `Files created: ${filesCreated.join(", ") || "none"}`,
    `Build: ${existsSync(packagePath) ? "passed" : "skipped (no package.json)"}`,
    `QA: ${passed ? "passed" : "review pending"}`,
    `Preview: ${qa.localDevUrl ?? "unavailable"}`,
    !passed ? "The app was built successfully. It still needs review for accessibility, responsive layout, and polish before marking complete." : null,
    `Local preview: cd "${folder}" then run npm run dev`,
    agentOutput ? `Agent output:\n${agentOutput.slice(-4000)}` : null,
    `Build output:\n${buildOutput.slice(-3000)}`,
  ].filter(Boolean).join("\n");
  await updateTask(db, task, {
    status: passed ? "completed" : "qa_pending",
    result: summary,
    error: null,
    log: summary,
  });
  await traceEvent(db, task, {
    phase: passed ? "completed" : "waiting_for_approval",
    source: "local_worker",
    severity: passed ? "info" : "warning",
    message: passed ? "Run completed after build and QA." : "Run built but needs review before completion.",
    details: { qaStatus: qa.qaStatus, preview: qa.localDevUrl ?? "unavailable" },
    status: passed ? "completed" : "waiting_approval",
    localFolderPath: folder,
  });
}

async function executeHermesChatTask(db: Client, task: QueueTask, capabilities: WorkerCapabilities): Promise<void> {
  if (!capabilities.hermesAgentAvailable || !capabilities.hermesAgentPath) {
    throw new Error("Hermes Nous is not installed or is unavailable on the Local Worker machine.");
  }
  if (!capabilities.hermesAgentAuthConfigured || !capabilities.hermesAgentModelConfigured) {
    throw new Error("Hermes Nous is not ready: run `hermes auth` and `hermes model` on the Local Worker machine.");
  }

  const payload = parseHermesChatPayload(task);
  const hermesCommand = path.join(path.dirname(capabilities.hermesAgentPath), "hermes.exe");
  const command = existsSync(hermesCommand) ? hermesCommand : "hermes";
  const args = [
    "chat",
    "-q",
    payload.message,
    "--quiet",
    "--source",
    "tool",
    "--max-turns",
    String(Number(process.env.HERMES_CHAT_MAX_TURNS ?? 20)),
  ];
  if (payload.hermesSessionId) args.push("--resume", payload.hermesSessionId);

  currentTask = `hermes_chat: ${task.title}`;
  lastHermesAgentRun = new Date().toISOString();
  lastHermesAgentError = null;
  await updateTask(db, task, {
    log: payload.hermesSessionId
      ? `Launching Hermes Nous chat on session ${payload.hermesSessionId}.`
      : "Launching Hermes Nous chat in a new native session.",
  });

  let output = "";
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: Number(process.env.HERMES_CHAT_TIMEOUT_MS ?? 4 * 60_000),
      maxBuffer: 1_000_000,
      env: hermesAgentProcessEnv(),
    });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    const detail = safeHermesOutput(`${processError.stdout ?? ""}\n${processError.stderr ?? ""}`.trim());
    throw new Error(detail || safeError(error));
  }

  const parsed = parseHermesChatOutput(output);
  const hermesSessionId = parsed.sessionId ?? payload.hermesSessionId;
  await db.execute({
    sql: `INSERT INTO ChatMessage (id, userId, role, content, channel, targetAgent, createdAt)
          VALUES (?, ?, 'assistant', ?, 'dashboard', 'hermes_nous', ?)`,
    args: [crypto.randomUUID(), task.userId, parsed.reply.slice(0, 12000), new Date().toISOString()],
  });
  await ensureHermesNousChatSessionTable(db);
  await db.execute({
    sql: `INSERT INTO HermesNousChatSession (userId, hermesSessionId, lastTaskId, createdAt, updatedAt)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(userId) DO UPDATE SET
            hermesSessionId = coalesce(excluded.hermesSessionId, HermesNousChatSession.hermesSessionId),
            lastTaskId = excluded.lastTaskId,
            updatedAt = datetime('now')`,
    args: [task.userId, hermesSessionId, task.id],
  });
  await updateTask(db, task, {
    status: "completed",
    result: [
      "Hermes Nous chat completed.",
      hermesSessionId ? `Native session: ${hermesSessionId}` : null,
      payload.chatMessageId ? `User message: ${payload.chatMessageId}` : null,
      `Reply: ${parsed.reply.slice(0, 500)}`,
    ].filter(Boolean).join("\n"),
    error: null,
    log: hermesSessionId ? `Hermes Nous replied on session ${hermesSessionId}.` : "Hermes Nous replied.",
  });
}

async function executeCouncilChatTask(db: Client, task: QueueTask): Promise<void> {
  const payload = parseCouncilChatPayload(task);
  currentTask = payload.mode === "council" ? `council_chat: ${task.title}` : `council_provider: ${payload.providerFamily ?? "unknown"}`;
  await updateTask(db, task, {
    log: payload.mode === "council"
      ? "Council debate started on the local worker."
      : `Direct Council provider chat started for ${payload.providerFamily}.`,
  });

  const entries = payload.mode === "provider"
    ? [payload.providerFamily ? getCouncilProvider(payload.providerFamily) : null].filter(Boolean)
    : councilProviderEntries();
  if (!entries.length) throw new Error("No Council provider entry matched this request.");

  const responses = [];
  for (const entry of entries) {
    await updateTask(db, task, { log: `Calling ${entry!.provider} (${entry!.roleLabel}).` });
    responses.push(await runCouncilProvider(entry!, payload.message));
  }
  const reply = safeHermesOutput(formatCouncilResponse(payload.mode, responses)).slice(0, 12000);
  await db.execute({
    sql: `INSERT INTO ChatMessage (id, userId, role, content, channel, targetAgent, createdAt)
          VALUES (?, ?, 'assistant', ?, 'dashboard', ?, ?)`,
    args: [crypto.randomUUID(), task.userId, reply, payload.target, new Date().toISOString()],
  });
  const answered = responses.filter((response) => response.status === "answered").length;
  const unavailable = responses.length - answered;
  await updateTask(db, task, {
    status: answered > 0 ? "completed" : "failed",
    result: [
      payload.mode === "council" ? "Council debate completed." : "Direct Council provider chat completed.",
      `Answered: ${answered}/${responses.length}`,
      unavailable ? `Unavailable: ${unavailable}` : null,
      payload.chatMessageId ? `User message: ${payload.chatMessageId}` : null,
    ].filter(Boolean).join("\n"),
    error: answered > 0 ? null : "No configured Council provider answered.",
    log: `Council chat finished with ${answered}/${responses.length} provider response(s).`,
  });
}

async function executeTask(db: Client, task: QueueTask): Promise<void> {
  await traceEvent(db, task, { phase: "initializing", source: "local_worker", message: "Worker initialized execution." });
  await throwIfCancellationRequested(db, task);
  if (task.assignedExecutor === "council_chat") {
    await executeCouncilChatTask(db, task);
    return;
  }
  if (task.assignedExecutor === "hermes_chat") {
    const capabilities = await getCapabilities();
    try {
      await executeHermesChatTask(db, task, capabilities);
      return;
    } catch (error) {
      lastHermesAgentError = safeError(error);
      throw error;
    }
  }
  if (task.assignedExecutor === "hermes_agent") {
    const capabilities = await getCapabilities();
    try {
      await executeHermesAgentTask(db, task, capabilities);
      return;
    } catch (error) {
      const hermesReason = safeError(error);
      lastHermesAgentError = hermesReason;
      await traceEvent(db, task, {
        phase: "codex_fallback_running",
        source: "hermes_nous",
        severity: "warning",
        message: `Hermes Nous failed: ${hermesReason}. Automatically fell back to Codex.`,
        details: { error: hermesReason, fallback: "automatic_codex" },
        lastSafeError: hermesReason,
        status: "running",
      }).catch(() => undefined);
      const fallbackTask = { ...task, assignedExecutor: "codex_cli" };
      await updateTask(db, task, { log: `Hermes Nous failed: ${hermesReason}. Automatically fell back to Codex.` }).catch(() => undefined);
      try {
        await executeLocalWorkerTask(db, fallbackTask);
        if (task.projectId) {
          await db.execute({
            sql: `UPDATE Project SET assignedAgent = 'codex_cli', updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
            args: [task.projectId, task.userId],
          }).catch(() => undefined);
        }
        await updateTask(db, task, { log: "Codex automatic fallback completed after Hermes Nous failure." }).catch(() => undefined);
        return;
      } catch (codexError) {
        const codexReason = safeError(codexError);
        await traceEvent(db, task, {
          phase: "failed",
          source: "codex",
          severity: "error",
          message: `Automatic Codex fallback failed: ${codexReason}`,
          details: { hermesError: hermesReason, codexError: codexReason },
          lastSafeError: codexReason,
          status: "failed",
        }).catch(() => undefined);
        throw new Error(`Hermes Nous failed (${hermesReason}); automatic Codex fallback also failed (${codexReason}).`);
      }
    }
  }
  await executeLocalWorkerTask(db, task);
}
async function executeLocalWorkerTask(db: Client, task: QueueTask): Promise<void> {
  const { action, message } = parseTaskPayload(task);
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported local worker action: ${action}`);
  }

  const builder = await import("../src/lib/local-builder");
  currentTask = `${action}: ${task.title}`;
  await updateTask(db, task, { log: `Executing ${action} on ${os.hostname()}.` });
  await updateProjectExecuting(db, task, action);
  await traceEvent(db, task, {
    phase: task.assignedExecutor === "codex_cli" ? "codex_fallback_running" : action === "runQa" ? "browser_qa" : "planning",
    source: task.assignedExecutor === "codex_cli" ? "codex" : "local_worker",
    message: `Executing ${action} on ${os.hostname()}.`,
    details: { commandCategory: action, executor: task.assignedExecutor },
  });
  await throwIfCancellationRequested(db, task);

  let project;
  if (action === "prepare") {
    await traceEvent(db, task, { phase: "preparing_workspace", source: "local_worker", message: "Preparing local project workspace." });
    project = await builder.prepareLocalBuildProject(task.userId, message);
    if (!project) throw new Error("Prepare action did not parse as a local build request.");
  } else {
    if (!task.projectId) throw new Error(`${action} requires a project id.`);
    if (action === "generate") {
      await traceEvent(db, task, { phase: "building", source: task.assignedExecutor === "codex_cli" ? "codex" : "local_worker", message: "Generating local starter app.", details: { commandCategory: "generate_app" } });
      project = await builder.generateLocalStarterApp(task.userId, task.projectId, message);
    } else if (action === "startDev") {
      await traceEvent(db, task, { phase: "starting_preview", source: "local_worker", message: "Starting local preview server.", details: { commandCategory: "start_preview" } });
      project = await builder.startLocalDevServer(task.userId, task.projectId);
    } else if (action === "stopDev") {
      project = await builder.stopLocalDevServer(task.userId, task.projectId);
    } else if (action === "runQa") {
      await traceEvent(db, task, { phase: "browser_qa", source: "qa", message: "Running local QA checklist.", details: { commandCategory: "qa" } });
      project = await builder.runLocalBuilderQa(task.userId, task.projectId);
    } else if (action === "rebuild" || action === "build" || action === "npmBuild") {
      await traceEvent(db, task, { phase: "building", source: task.assignedExecutor === "codex_cli" ? "codex" : "local_worker", message: "Rebuilding local starter app.", details: { commandCategory: "build" } });
      project = await builder.rebuildLocalStarterApp(task.userId, task.projectId);
    }
  }

  if (!project) throw new Error(`No project result returned for action: ${action}`);

  if (["generate", "rebuild", "build", "npmBuild"].includes(action) && task.projectId && !/failed/i.test(project.status)) {
    await traceEvent(db, task, { phase: "starting_preview", source: "local_worker", message: "Starting preview and browser QA.", details: { commandCategory: "preview_and_browser_qa" } });
    await throwIfCancellationRequested(db, task);
    project = await builder.startPreviewAndRunBrowserQa(task.userId, task.projectId);
    await traceEvent(db, task, { phase: "browser_qa", source: "qa", message: "Browser QA completed.", details: { qaStatus: project.qaStatus ?? "unknown", localDevUrl: project.localDevUrl ?? "unavailable" } });
  }

  const finalStatus = taskStatusForProjectStatus(project.status);
  const result = [
    `${action} finished for ${project.projectName}.`,
    `Project status: ${project.status}`,
    `Folder: ${project.localFolderPath}`,
    project.qaStatus ? `QA: ${project.qaStatus}` : null,
    project.buildError ? `First error: ${project.buildError}` : null,
  ].filter(Boolean).join("\n");

  await updateTask(db, task, {
    status: finalStatus,
    result,
    error: finalStatus === "failed" ? project.buildError ?? "Local worker action failed." : null,
    log: result,
  });
  await traceEvent(db, task, {
    phase: finalStatus === "failed" ? "failed" : finalStatus === "qa_pending" ? "waiting_for_approval" : "completed",
    source: "local_worker",
    severity: finalStatus === "failed" ? "error" : finalStatus === "qa_pending" ? "warning" : "info",
    message: finalStatus === "failed" ? "Local worker action failed." : `${action} finished for ${project.projectName}.`,
    details: { projectStatus: project.status, qaStatus: project.qaStatus ?? "none" },
    status: finalStatus === "failed" ? "failed" : finalStatus === "qa_pending" ? "waiting_approval" : "completed",
    localFolderPath: project.localFolderPath,
    lastSafeError: finalStatus === "failed" ? project.buildError ?? "Local worker action failed." : null,
  });
}

async function runLoop(): Promise<void> {
  loadLocalEnv();
  const apiBaseUrl = workerApiBaseUrl();
  const db = createDb();
  const capabilities = await getCapabilities();
  await ensureWorkerTables(db);
  await recoverStaleTasks(db);
  const builder = await import("../src/lib/local-builder");
  await builder.markDeadPreviewsStale().catch((error) => { lastError = safeError(error); });
  console.log(`Worker API Base URL: ${apiBaseUrl}`);
  // A failing health endpoint must not crash-loop the worker — record the
  // error and keep polling; the loop retries the heartbeat every cycle.
  await heartbeat(db, capabilities, apiBaseUrl).catch((error) => {
    lastError = safeError(error);
    console.error(`Initial heartbeat failed (${lastError}); continuing to poll.`);
  });

  console.log(`Hermes Local Worker ${WORKER_ID} online on ${os.hostname()}.`);
  console.log(`Root: ${process.env.HERMES_LOCAL_PROJECTS_ROOT}`);
  console.log(`Polling every ${Math.round(POLL_MS / 1000)}s.`);

  let lastHeartbeat = Date.now();
  let lastRecovery = 0;
  let stopping = false;
  const runOnce = process.env.HERMES_LOCAL_WORKER_ONCE === "1";
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await markWorkerOffline(db, capabilities, apiBaseUrl);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  while (!stopping) {
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      await heartbeat(db, capabilities, apiBaseUrl).catch((error) => {
        lastError = safeError(error);
      });
      lastHeartbeat = now;
    }
    if (now - lastRecovery >= HEARTBEAT_MS) {
      await recoverStaleTasks(db).catch((error) => { lastError = safeError(error); });
      await builder.markDeadPreviewsStale().catch((error) => { lastError = safeError(error); });
      lastRecovery = now;
    }

    // Fire-and-forget — the interval/in-flight guards live inside, and a slow
    // or failing poll must never block task claiming.
    void maybePollEmailWatcher(apiBaseUrl);

    const task = await claimTask(db).catch((error) => {
      lastError = safeError(error);
      return null;
    });

    if (task) {
      const maintenance = setInterval(() => {
        void Promise.all([
          renewTaskLease(db, task.id),
          heartbeat(db, capabilities, apiBaseUrl),
          heartbeatExecutionRun(db, task, currentTask ?? undefined),
          // Long builds block the main loop for minutes — keep the inbox
          // poll alive from here too (internally throttled).
          maybePollEmailWatcher(apiBaseUrl),
        ]).catch((error) => { lastError = safeError(error); });
      }, HEARTBEAT_MS);
      try {
        await heartbeat(db, capabilities, apiBaseUrl);
        await executeTask(db, task);
        lastError = null;
      } catch (error) {
        lastError = safeError(error);
        if (task.assignedExecutor === "hermes_agent") lastHermesAgentError = lastError;
        if (error instanceof CancellationRequestedError) {
          await updateTask(db, task, { status: "cancelled", result: "Cancellation confirmed by local worker.", error: null, log: "Cancelled by request." }).catch(() => undefined);
        } else {
          await traceEvent(db, task, {
            phase: "failed",
            source: task.assignedExecutor === "hermes_agent" ? "hermes_nous" : "local_worker",
            severity: "error",
            message: `Failed: ${lastError}`,
            lastSafeError: lastError,
            status: "failed",
          }).catch(() => undefined);
          await updateTask(db, task, { status: "failed", error: lastError, log: `Failed: ${lastError}` }).catch(() => undefined);
        }
      } finally {
        clearInterval(maintenance);
        currentTask = null;
        await heartbeat(db, capabilities, apiBaseUrl).catch(() => undefined);
      }
    }

    if (runOnce) {
      await markWorkerOffline(db, capabilities, apiBaseUrl);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

runLoop().catch((error) => {
  console.error(safeError(error));
  process.exit(1);
});
