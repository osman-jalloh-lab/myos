import { createClient, type Client } from "@libsql/client";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type QueueTask = {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: string;
  projectId: string | null;
  logs: string | null;
};

type WorkerCapabilities = {
  nodeVersion: string;
  npmVersion: string | null;
  gitAvailable: boolean;
  codexAvailable: boolean;
};

const execFileAsync = promisify(execFile);
const POLL_MS = Number(process.env.HERMES_LOCAL_WORKER_POLL_MS ?? 15_000);
const HEARTBEAT_MS = Number(process.env.HERMES_LOCAL_WORKER_HEARTBEAT_MS ?? 45_000);
const WORKER_ID = process.env.HERMES_LOCAL_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`;
const LOCAL_ROOT = "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject";
const ALLOWED_ACTIONS = new Set(["prepare", "generate", "runQa", "rebuild", "build", "npmBuild", "startDev", "stopDev"]);

let currentTask: string | null = null;
let lastError: string | null = null;

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
  process.env.HERMES_LOCAL_PROJECTS_ROOT = process.env.HERMES_LOCAL_PROJECTS_ROOT?.trim() || LOCAL_ROOT;
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
    .slice(0, 2000);
}

async function ensureWorkerTables(db: Client): Promise<void> {
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
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
}

async function commandAvailable(command: string, args: string[]): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await execFileAsync(command, args, {
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
  const [npm, git, codex] = await Promise.all([
    commandAvailable("npm", ["--version"]),
    commandAvailable("git", ["--version"]),
    commandAvailable("codex", ["--version"]),
  ]);
  return {
    nodeVersion: process.version,
    npmVersion: npm.version,
    gitAvailable: git.available,
    codexAvailable: codex.available,
  };
}

async function heartbeat(db: Client, capabilities: WorkerCapabilities): Promise<void> {
  await ensureWorkerTables(db);
  await db.execute({
    sql: `
      INSERT INTO LocalWorkerHeartbeat (
        workerId, machineName, status, lastHeartbeat, rootPath, nodeVersion, npmVersion,
        gitAvailable, codexAvailable, currentTask, lastError, updatedAt
      ) VALUES (?, ?, 'online', datetime('now'), ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        updatedAt = datetime('now')
    `,
    args: [
      WORKER_ID,
      os.hostname(),
      process.env.HERMES_LOCAL_PROJECTS_ROOT ?? LOCAL_ROOT,
      capabilities.nodeVersion,
      capabilities.npmVersion,
      capabilities.gitAvailable ? 1 : 0,
      capabilities.codexAvailable ? 1 : 0,
      currentTask,
      lastError,
    ],
  });
}

async function markWorkerOffline(db: Client, capabilities: WorkerCapabilities): Promise<void> {
  await db.execute({
    sql: `UPDATE LocalWorkerHeartbeat SET status = 'offline', currentTask = NULL, lastError = ?, updatedAt = datetime('now') WHERE workerId = ?`,
    args: [lastError ?? "Worker stopped.", WORKER_ID],
  }).catch(async () => heartbeat(db, capabilities).catch(() => undefined));
}

async function claimTask(db: Client): Promise<QueueTask | null> {
  const res = await db.execute({
    sql: `
      SELECT id, userId, title, description, status, project_id, logs
      FROM AgentTask
      WHERE assigned_executor = 'local_worker' AND status = 'queued'
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
  };

  const update = await db.execute({
    sql: `
      UPDATE AgentTask
      SET status = 'executing', logs = ?, updatedAt = datetime('now')
      WHERE id = ? AND status = 'queued' AND assigned_executor = 'local_worker'
    `,
    args: [appendLog(task.logs, `Claimed by local worker ${WORKER_ID}.`), task.id],
  });

  return update.rowsAffected > 0 ? task : null;
}

async function updateTask(db: Client, task: QueueTask, params: { status?: string; result?: string | null; error?: string | null; log?: string }): Promise<void> {
  const current = await db.execute({ sql: `SELECT logs FROM AgentTask WHERE id = ? LIMIT 1`, args: [task.id] });
  const existingLogs = typeof (current.rows[0] as Record<string, unknown> | undefined)?.logs === "string"
    ? String((current.rows[0] as Record<string, unknown>).logs)
    : task.logs;
  const fields: string[] = [];
  const args: (string | null)[] = [];
  if (params.status) {
    fields.push("status = ?");
    args.push(params.status);
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
  if (!fields.length) return;
  fields.push("updatedAt = datetime('now')");
  args.push(task.id);
  await db.execute({ sql: `UPDATE AgentTask SET ${fields.join(", ")} WHERE id = ?`, args });
}

async function updateProjectExecuting(db: Client, task: QueueTask, action: string): Promise<void> {
  if (!task.projectId) return;
  await db.execute({
    sql: `
      UPDATE Project
      SET status = 'executing_on_local_worker',
          assignedAgent = 'local_worker',
          localBuildLog = substr(coalesce(localBuildLog, '') || char(10) || ?, -12000),
          localBuildError = NULL,
          updatedAt = datetime('now')
      WHERE id = ? AND userId = ?
    `,
    args: [`Local Worker ${WORKER_ID} started ${action}.`, task.projectId, task.userId],
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

async function executeTask(db: Client, task: QueueTask): Promise<void> {
  const { action, message } = parseTaskPayload(task);
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported local worker action: ${action}`);
  }

  const builder = await import("../src/lib/local-builder");
  currentTask = `${action}: ${task.title}`;
  await updateTask(db, task, { log: `Executing ${action} on ${os.hostname()}.` });
  await updateProjectExecuting(db, task, action);

  let project;
  if (action === "prepare") {
    project = await builder.prepareLocalBuildProject(task.userId, message);
    if (!project) throw new Error("Prepare action did not parse as a local build request.");
  } else {
    if (!task.projectId) throw new Error(`${action} requires a project id.`);
    if (action === "generate") {
      project = await builder.generateLocalStarterApp(task.userId, task.projectId, message);
    } else if (action === "startDev") {
      project = await builder.startLocalDevServer(task.userId, task.projectId);
    } else if (action === "stopDev") {
      project = await builder.stopLocalDevServer(task.userId, task.projectId);
    } else if (action === "runQa") {
      project = await builder.runLocalBuilderQa(task.userId, task.projectId);
    } else if (action === "rebuild" || action === "build" || action === "npmBuild") {
      project = await builder.rebuildLocalStarterApp(task.userId, task.projectId);
    }
  }

  if (!project) throw new Error(`No project result returned for action: ${action}`);

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
}

async function runLoop(): Promise<void> {
  loadLocalEnv();
  const db = createDb();
  const capabilities = await getCapabilities();
  await ensureWorkerTables(db);
  await heartbeat(db, capabilities);

  console.log(`Hermes Local Worker ${WORKER_ID} online on ${os.hostname()}.`);
  console.log(`Root: ${process.env.HERMES_LOCAL_PROJECTS_ROOT}`);
  console.log(`Polling every ${Math.round(POLL_MS / 1000)}s.`);

  let lastHeartbeat = 0;
  let stopping = false;
  const runOnce = process.env.HERMES_LOCAL_WORKER_ONCE === "1";
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await markWorkerOffline(db, capabilities);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  while (!stopping) {
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      await heartbeat(db, capabilities).catch((error) => {
        lastError = safeError(error);
      });
      lastHeartbeat = now;
    }

    const task = await claimTask(db).catch((error) => {
      lastError = safeError(error);
      return null;
    });

    if (task) {
      try {
        await heartbeat(db, capabilities);
        await executeTask(db, task);
        lastError = null;
      } catch (error) {
        lastError = safeError(error);
        await updateTask(db, task, { status: "failed", error: lastError, log: `Failed: ${lastError}` }).catch(() => undefined);
      } finally {
        currentTask = null;
        await heartbeat(db, capabilities).catch(() => undefined);
      }
    }

    if (runOnce) {
      await markWorkerOffline(db, capabilities);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

runLoop().catch((error) => {
  console.error(safeError(error));
  process.exit(1);
});
