import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { auth } from "@/lib/auth";
import { readSessionContextState } from "@/lib/memory-context";
import {
  buildStatusMeaning,
  extractBuildFiles,
  inferAppType,
  parseTimestampedLog,
  redactBuildText,
  type BuildStepStatus,
  type BuildTimelineStep,
  type LiveBuildConsoleData,
  type LiveBuildLog,
} from "@/lib/live-build-console";

type Row = Record<string, unknown>;
const ACTIVE = new Set(["Researching", "Brief Ready", "Ready to Build", "queued_for_local_worker", "planning", "Generating", "Installing", "Building", "executing_on_local_worker", "qa_running", "qa_pending", "Dev Server Running"]);

function db() {
  return createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return value.split(/\r?\n/).filter(Boolean); }
}
function timestampFor(lines: string[], pattern: RegExp, fallback: string): string | null {
  const line = lines.find((entry) => pattern.test(entry));
  return line ? parseTimestampedLog(line).timestamp ?? fallback : null;
}
function step(key: string, label: string, status: BuildStepStatus, timestamp: string | null): BuildTimelineStep {
  return { key, label, status, timestamp };
}
function executionLabel(value: string): string {
  if (value === "hermes_agent") return "Hermes Agent";
  if (value === "local_worker") return "Local Worker";
  return value.includes("builder") ? "Local Builder" : value || "Local Builder";
}
function logStatus(message: string): LiveBuildLog["status"] {
  if (/failed|error/i.test(message)) return "error";
  if (/passed|completed|ready|created|wrote/i.test(message)) return "success";
  if (/waiting|pending|stale/i.test(message)) return "warning";
  return "info";
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  const requestedId = new URL(request.url).searchParams.get("projectId");
  const client = db();
  const projects = await client.execute({ sql: `SELECT * FROM Project WHERE userId = ? ORDER BY updatedAt DESC LIMIT 30`, args: [userId] });
  const rows = projects.rows as unknown as Row[];
  const selected = requestedId
    ? rows.find((row) => text(row.id) === requestedId)
    : rows.find((row) => ACTIVE.has(text(row.status)));

  const heartbeatResult = await client.execute(`SELECT * FROM LocalWorkerHeartbeat ORDER BY lastHeartbeat DESC LIMIT 1`).catch(() => ({ rows: [] }));
  const heartbeat = (heartbeatResult.rows[0] as unknown as Row | undefined) ?? null;
  const heartbeatAt = text(heartbeat?.lastHeartbeat);
  const heartbeatAge = heartbeatAt ? Date.now() - new Date(heartbeatAt).getTime() : Number.POSITIVE_INFINITY;
  const workerStatus: "online" | "offline" | "stale" = text(heartbeat?.status) === "offline" || heartbeatAge > 90_000 ? "offline" : heartbeatAge > 45_000 ? "stale" : "online";

  const context = !requestedId ? await readSessionContextState(`dashboard:shared:${userId}`, userId).catch(() => null) : null;
  const intake = context?.rememberedEntities.buildProject?.intake;
  const collecting = context?.activeIntent === "active_build_project" && intake?.status === "collecting";
  if (collecting || !selected) {
    const empty: LiveBuildConsoleData = {
      active: Boolean(collecting),
      project: collecting ? {
        id: "intake",
        name: context?.rememberedEntities.buildProject?.projectName ?? "New project",
        appType: inferAppType(intake?.originalRequest ?? "website"),
        folderPath: null,
        executor: "Local Builder",
        status: "waiting_for_requirements",
        statusMeaning: "Waiting for your answers",
        startedAt: null,
        updatedAt: new Date().toISOString(),
        elapsedMs: 0,
        stuck: false,
        minutesSinceUpdate: 0,
      } : null,
      timeline: collecting ? [step("intake", "Intake", "complete", null), step("clarifying", "Clarifying Questions", "running", null)] : [],
      logs: [], files: [], preview: null,
      worker: { status: workerStatus, lastHeartbeat: heartbeatAt || null },
    };
    return NextResponse.json(empty);
  }

  const projectId = text(selected.id);
  const [taskResult, projectTaskResult, runResult] = await Promise.all([
    client.execute({ sql: `SELECT * FROM AgentTask WHERE userId = ? AND project_id = ? ORDER BY updatedAt DESC LIMIT 12`, args: [userId, projectId] }).catch(() => ({ rows: [] })),
    client.execute({ sql: `SELECT * FROM ProjectTask WHERE userId = ? AND projectId = ? ORDER BY updatedAt ASC`, args: [userId, projectId] }).catch(() => ({ rows: [] })),
    client.execute({ sql: `SELECT * FROM AgentRun WHERE (inputSummary LIKE ? OR outputSummary LIKE ?) ORDER BY createdAt ASC LIMIT 80`, args: [`%${text(selected.projectName)}%`, `%${text(selected.projectName)}%`] }).catch(() => ({ rows: [] })),
  ]);
  const queueTasks = taskResult.rows as unknown as Row[];
  const projectTasks = projectTaskResult.rows as unknown as Row[];
  const runs = runResult.rows as unknown as Row[];
  const queueTask = queueTasks[0];
  const queueLogs = queueTasks.flatMap((task) => parseArray(task.logs).map(String));
  const buildLines = text(selected.localBuildLog).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const allText = [text(selected.latestInstruction), text(selected.localBuildLog), text(selected.localResearchBrief), text(selected.localDesignReview), ...queueLogs, ...queueTasks.map((row) => `${text(row.result)} ${text(row.error)} ${text(row.files)}`)].join("\n");
  const executor = text(queueTask?.assigned_executor) || text(selected.assignedAgent) || "hermes-local-builder";
  const projectStatus = text(queueTask?.status) || text(selected.status);
  const createdAt = text(selected.createdAt) || new Date().toISOString();
  const updatedAt = [text(selected.updatedAt), ...queueTasks.map((row) => text(row.updatedAt))].filter(Boolean).sort().at(-1) ?? createdAt;
  const minutesSinceUpdate = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60_000));
  const active = !/completed|failed|qa_passed/i.test(projectStatus) && text(selected.status) !== "completed";
  const failed = /failed/i.test(`${projectStatus} ${text(selected.status)} ${text(selected.localBuildError)} ${text(queueTask?.error)}`);
  const has = (pattern: RegExp) => pattern.test(allText);
  const files = extractBuildFiles(allText);
  const browserChecks = parseArray(selected.localQaChecklist).filter((item): item is Row => typeof item === "object" && item !== null && /^browser_/.test(text((item as Row).key)));
  const previewUrl = text(selected.localDevUrl);
  const qts = (pattern: RegExp) => timestampFor(queueLogs, pattern, updatedAt);
  const timeline: BuildTimelineStep[] = [
    step("intake", "Intake", "complete", createdAt),
    step("clarifying", "Clarifying Questions", has(/clarification required|waiting_for_requirements/i) ? "running" : "skipped", has(/clarification required|waiting_for_requirements/i) ? updatedAt : null),
    step("planning", "Planning", /Researching|Brief Ready/.test(text(selected.status)) ? "running" : "complete", createdAt),
    step("knowledge", "Knowledge Cards Loaded", has(/loaded knowledge cards|Knowledge cards loaded/i) ? "complete" : active ? "pending" : "skipped", has(/loaded knowledge cards|Knowledge cards loaded/i) ? updatedAt : null),
    step("athena", "Athena Research", text(selected.localResearchBrief) ? "complete" : /Researching/.test(text(selected.status)) ? "running" : "skipped", text(selected.localResearchBrief) ? createdAt : null),
    step("fugu", "Fugu Review", text(selected.localDesignReview) ? "complete" : active ? "pending" : "skipped", text(selected.localDesignReview) ? updatedAt : null),
    step("claimed", "Worker Claimed Task", has(/Claimed by local worker/i) ? "complete" : text(queueTask?.status) === "executing" ? "running" : "pending", qts(/Claimed by local worker/i)),
    step("hermes", "Hermes Agent Running", executor === "hermes_agent" ? text(queueTask?.status) === "executing" ? "running" : has(/Launching Hermes Agent|Hermes Agent completed/i) ? "complete" : "pending" : "skipped", qts(/Launching Hermes Agent|Hermes Agent completed/i)),
    step("files", "Files Created", files.length ? "complete" : /Generating/.test(text(selected.status)) ? "running" : "pending", files.length ? updatedAt : null),
    step("install", "Dependencies Installed", has(/Installing:\s*passed|Dependencies already present|Dependencies installed successfully/i) ? "complete" : /Installing/.test(text(selected.status)) || has(/Dependencies install started/i) ? "running" : failed && has(/npm install/i) ? "failed" : "pending", qts(/Dependencies install|Dependencies installed/i) ?? updatedAt),
    step("build", "Build Running", has(/Building:\s*passed|Rebuild:\s*passed|npm run build passed/i) ? "complete" : /Building/.test(text(selected.status)) || has(/npm run build started/i) ? "running" : failed && has(/build failed/i) ? "failed" : "pending", qts(/npm run build|build passed/i) ?? updatedAt),
    step("browser", "Browser QA Running", browserChecks.length ? browserChecks.some((item) => text(item.status) === "failed") ? "failed" : "complete" : has(/Browser QA.*(?:passed|needs review)/i) ? "complete" : has(/Browser QA/i) ? "running" : "pending", qts(/Browser QA/i) ?? (browserChecks.length ? updatedAt : null)),
    step("preview", "Preview Started", previewUrl ? text(selected.localPreviewStatus) === "stale" ? "failed" : "complete" : "pending", qts(/preview.*started/i) ?? (previewUrl ? updatedAt : null)),
    step("finish", failed ? "Failed" : "Completed", failed ? "failed" : active ? "pending" : "complete", failed || !active ? updatedAt : null),
  ];

  const logs: LiveBuildLog[] = [];
  for (const line of queueLogs) {
    const parsed = parseTimestampedLog(line);
    logs.push({ timestamp: parsed.timestamp, source: /Hermes Agent/i.test(parsed.message) ? "Hermes Agent" : /Claimed|worker/i.test(parsed.message) ? "Local Worker" : "Execution Queue", message: parsed.message, technical: /route=|executor=|reason=|task=|project=/i.test(parsed.message), status: logStatus(parsed.message) });
  }
  for (const line of buildLines.slice(-80)) {
    if (!line || /^[-=]{3,}$/.test(line)) continue;
    const source = /Browser QA/i.test(line) ? "Browser QA" : /Fugu/i.test(line) ? "Fugu" : /Installing|npm install/i.test(line) ? "npm install" : /Building|npm run build|Rebuild/i.test(line) ? "npm run build" : "Builder";
    logs.push({ timestamp: null, source, message: redactBuildText(line), technical: /^(>|npm WARN|\u25b2|Route \(|\u251c|\u2514|\u0192)|node_modules|Turbopack/i.test(line), status: logStatus(line) });
  }
  for (const run of runs) {
    const message = redactBuildText(text(run.outputSummary) || text(run.inputSummary));
    if (message) logs.push({ timestamp: text(run.createdAt) || null, source: text(run.agentName) || "Agent", message, technical: /project=|local_build_/i.test(text(run.inputSummary)), status: logStatus(`${text(run.status)} ${message}`) });
  }
  logs.sort((a, b) => new Date(a.timestamp ?? createdAt).getTime() - new Date(b.timestamp ?? createdAt).getTime());

  const result: LiveBuildConsoleData = {
    active,
    project: {
      id: projectId,
      name: text(selected.projectName),
      appType: inferAppType(`${text(selected.latestInstruction)} ${text(selected.description)} ${text(selected.projectName)}`),
      folderPath: text(selected.localFolderPath) ? redactBuildText(text(selected.localFolderPath)) : null,
      executor: executionLabel(executor),
      status: projectStatus || text(selected.status),
      statusMeaning: buildStatusMeaning(projectStatus || text(selected.status), executor, allText, Boolean(previewUrl)),
      startedAt: createdAt,
      updatedAt,
      elapsedMs: Math.max(0, Date.now() - new Date(createdAt).getTime()),
      stuck: active && minutesSinceUpdate >= 5,
      minutesSinceUpdate,
    },
    timeline,
    logs: logs.slice(-160),
    files,
    preview: previewUrl ? { url: previewUrl, status: text(selected.localPreviewStatus) || "online", manualCommand: text(selected.localFolderPath) ? `cd "${redactBuildText(text(selected.localFolderPath))}"\nnpm run dev` : null } : null,
    worker: { status: workerStatus, lastHeartbeat: heartbeatAt || null },
  };
  return NextResponse.json(result);
}
