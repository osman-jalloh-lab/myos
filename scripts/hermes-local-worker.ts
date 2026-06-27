import { createClient, type Client } from "@libsql/client";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  assignedExecutor: string;
};

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
const HEARTBEAT_MS = Number(process.env.HERMES_LOCAL_WORKER_HEARTBEAT_MS ?? 45_000);
const WORKER_ID = process.env.HERMES_LOCAL_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`;
const LOCAL_ROOT = "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject";
const ALLOWED_ACTIONS = new Set(["prepare", "generate", "runQa", "rebuild", "build", "npmBuild", "startDev", "stopDev"]);

let currentTask: string | null = null;
let lastError: string | null = null;
let lastFetchError: string | null = null;
let lastHermesAgentRun: string | null = null;
let lastHermesAgentError: string | null = null;

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
        WORKER_ID, os.hostname(), process.env.HERMES_LOCAL_PROJECTS_ROOT ?? LOCAL_ROOT,
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
      process.env.HERMES_LOCAL_PROJECTS_ROOT ?? LOCAL_ROOT,
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
      WHERE assigned_executor IN ('local_worker', 'hermes_agent') AND status = 'queued'
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
      SET status = 'executing', logs = ?, updatedAt = datetime('now')
      WHERE id = ? AND status = 'queued' AND assigned_executor = ?
    `,
    args: [appendLog(task.logs, `Claimed by local worker ${WORKER_ID} for ${task.assignedExecutor}.`), task.id, task.assignedExecutor],
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

function hermesAgentProcessEnv(cwd?: string): NodeJS.ProcessEnv {
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
  return value
    .replace(/^.*Using API key:.*$/gim, "[Hermes credential configured]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

async function assertSafeHermesProjectFolder(folder: string): Promise<string> {
  const root = path.resolve(process.env.HERMES_LOCAL_PROJECTS_ROOT ?? LOCAL_ROOT);
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
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
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
    env: hermesAgentProcessEnv(folder),
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
  if (!capabilities.hermesAgentAvailable || !capabilities.hermesAgentPath) {
    throw new Error("Hermes Agent is not installed or is unavailable on the Local Worker machine.");
  }
  if (!capabilities.hermesAgentAuthConfigured || !capabilities.hermesAgentModelConfigured) {
    throw new Error("Hermes Agent is not ready: run `hermes auth` and `hermes model` on the Local Worker machine.");
  }

  const builder = await import("../src/lib/local-builder");
  const packet = await builder.buildHermesAgentExecutionPrompt(task.userId, task.projectId, task.description);
  const folder = await assertSafeHermesProjectFolder(packet.folder);
  const beforeDirectories = await listDirectories(folder);
  const promptName = `HERMES_AGENT_TASK_${task.id}.md`;
  const promptPath = path.join(folder, promptName);
  await writeFile(promptPath, packet.prompt, { encoding: "utf8", flag: "wx" });

  currentTask = `hermes_agent: ${task.title}`;
  lastHermesAgentRun = new Date().toISOString();
  lastHermesAgentError = null;
  await updateTask(db, task, { log: `Launching Hermes Agent ${capabilities.hermesAgentVersion ?? "unknown version"} in ${folder}.` });
  await updateProjectExecuting(db, task, "hermes_agent");

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
        env: hermesAgentProcessEnv(folder),
      });
      agentOutput = safeHermesOutput(`${result.stdout}${result.stderr}`.trim());
    } catch (error) {
      const processError = error as Error & { stdout?: string; stderr?: string };
      const detail = safeHermesOutput(`${processError.stdout ?? ""}\n${processError.stderr ?? ""}`.trim());
      throw new Error(detail || safeError(error));
    }
  } finally {
    await rm(promptPath, { force: true }).catch(() => undefined);
  }

  const afterDirectories = await listDirectories(folder);
  const deletedDirectories = [...beforeDirectories].filter((item) => !afterDirectories.has(item));
  if (deletedDirectories.length) throw new Error(`Hermes Agent safety check failed: deleted folder(s): ${deletedDirectories.slice(0, 8).join(", ")}`);

  if (packet.requiresNextContract) await verifyParawiLocalAppContract(folder);

  const packagePath = path.join(folder, "package.json");
  let buildOutput = "No package.json found; npm build skipped.";
  if (existsSync(packagePath)) {
    const installOutput = existsSync(path.join(folder, "node_modules")) ? "Dependencies already present." : await runNpm(folder, ["install"], 10 * 60_000);
    buildOutput = `${installOutput}\n${await runNpm(folder, ["run", "build"], 10 * 60_000)}`.trim();
  }

  await db.execute({
    sql: `UPDATE Project SET status = 'qa_pending', assignedAgent = 'hermes_agent', localBuildLog = substr(coalesce(localBuildLog, '') || char(10) || ?, -12000), localBuildError = NULL, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
    args: [`Installing: passed\nBuilding: passed\n${buildOutput}`, task.projectId, task.userId],
  });

  const qa = await builder.runLocalBuilderQa(task.userId, task.projectId);
  const passed = qa.status === "completed" || qa.status === "qa_passed";
  const filesCreated = await listReportableFiles(folder);
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
}

async function executeTask(db: Client, task: QueueTask): Promise<void> {
  if (task.assignedExecutor === "hermes_agent") {
    const capabilities = await getCapabilities();
    await executeHermesAgentTask(db, task, capabilities);
    return;
  }
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
  const apiBaseUrl = workerApiBaseUrl();
  const db = createDb();
  const capabilities = await getCapabilities();
  await ensureWorkerTables(db);
  console.log(`Worker API Base URL: ${apiBaseUrl}`);
  await heartbeat(db, capabilities, apiBaseUrl);

  console.log(`Hermes Local Worker ${WORKER_ID} online on ${os.hostname()}.`);
  console.log(`Root: ${process.env.HERMES_LOCAL_PROJECTS_ROOT}`);
  console.log(`Polling every ${Math.round(POLL_MS / 1000)}s.`);

  let lastHeartbeat = 0;
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

    const task = await claimTask(db).catch((error) => {
      lastError = safeError(error);
      return null;
    });

    if (task) {
      try {
        await heartbeat(db, capabilities, apiBaseUrl);
        await executeTask(db, task);
        lastError = null;
      } catch (error) {
        lastError = safeError(error);
        if (task.assignedExecutor === "hermes_agent") lastHermesAgentError = lastError;
        await updateTask(db, task, { status: "failed", error: lastError, log: `Failed: ${lastError}` }).catch(() => undefined);
      } finally {
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
