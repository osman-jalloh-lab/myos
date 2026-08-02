import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { auth } from "@/lib/auth";
import { readSessionContextState } from "@/lib/memory-context";
import { updateExecutionQueueTask } from "@/lib/execution-queue";
import { diagnoseBuildFailure } from "@/lib/build-failure-diagnostics";
import { deriveCanonicalBuilderStage, withCanonicalBuilderStage } from "@/lib/builder-lifecycle";
import {
  buildStatusMeaning,
  canonicalLiveBuildTimeline,
  extractBuildFiles,
  inferAppType,
  parseTimestampedLog,
  redactBuildText,
  type LiveBuildConsoleData,
  type LiveBuildLog,
} from "@/lib/live-build-console";

type Row = Record<string, unknown>;

function db() {
  return createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return value.split(/\r?\n/).filter(Boolean); }
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
    : rows.find((row) => !["completed", "failed"].includes(deriveCanonicalBuilderStage({ status: row.status, localQaStatus: row.localQaStatus })));

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
      project: collecting ? withCanonicalBuilderStage({
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
      }) : null,
      timeline: collecting ? canonicalLiveBuildTimeline("queued", null) : [],
      logs: [], files: [], preview: null,
      worker: { status: workerStatus, lastHeartbeat: heartbeatAt || null }, inspector: null,
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
  const allText = [text(selected.latestInstruction), text(selected.localBuildLog), text(selected.localResearchBrief), ...queueLogs, ...queueTasks.map((row) => `${text(row.result)} ${text(row.error)} ${text(row.files)}`)].join("\n");
  const executor = text(queueTask?.assigned_executor) || text(selected.assignedAgent) || "hermes-local-builder";
  const projectStatus = text(queueTask?.status) || text(selected.status);
  const createdAt = text(selected.createdAt) || new Date().toISOString();
  const updatedAt = [text(selected.updatedAt), ...queueTasks.map((row) => text(row.updatedAt))].filter(Boolean).sort().at(-1) ?? createdAt;
  const minutesSinceUpdate = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60_000));
  const canonicalStage = deriveCanonicalBuilderStage({ status: selected.status, localQaStatus: selected.localQaStatus });
  const active = canonicalStage !== "completed" && canonicalStage !== "failed";
  const failed = canonicalStage === "failed";
  const files = extractBuildFiles(allText);
  const previewUrl = text(selected.localDevUrl);
  const timeline = canonicalLiveBuildTimeline(canonicalStage, updatedAt);
  const diagnostic = failed ? diagnoseBuildFailure([
    text(selected.localBuildError),
    text(queueTask?.error),
    ...queueTasks.map((row) => text(row.error)),
    ...queueLogs.slice().reverse(),
    ...buildLines.slice().reverse(),
  ]) : null;
  const diagnosticStep = diagnostic ? ({
    filesystem: "Files Created",
    local_worker: "Worker Claimed Task",
    hermes_agent: "Hermes Agent Running",
    github: "Repository Access",
    vercel: "Deployment",
    build: "Build Running",
    qa: "Browser QA Running",
    unknown: "Unknown step",
  } as Record<string, string>)[diagnostic.category] : null;
  const runningStep = timeline.find((item) => item.status === "running");
  const failedStep = timeline.find((item) => item.status === "failed");
  const pendingStep = timeline.find((item) => item.status === "pending");
  const completedSteps = timeline.filter((item) => item.status === "complete");

  const logs: LiveBuildLog[] = [];
  for (const line of queueLogs) {
    const parsed = parseTimestampedLog(line);
    logs.push({ timestamp: parsed.timestamp, source: /Hermes Agent/i.test(parsed.message) ? "Hermes Agent" : /Claimed|worker/i.test(parsed.message) ? "Local Worker" : "Execution Queue", message: parsed.message, technical: /route=|executor=|reason=|task=|project=/i.test(parsed.message), status: logStatus(parsed.message) });
  }
  for (const line of buildLines.slice(-80)) {
    if (!line || /^[-=]{3,}$/.test(line)) continue;
    const source = /Browser QA/i.test(line) ? "Browser QA" : /Installing|npm install/i.test(line) ? "npm install" : /Building|npm run build|Rebuild/i.test(line) ? "npm run build" : "Builder";
    const message = redactBuildText(line).replace(/\bfugu\b/gi, "Builder").replace(/\bsakana\b/gi, "");
    logs.push({ timestamp: null, source, message, technical: /^(>|npm WARN|\u25b2|Route \(|\u251c|\u2514|\u0192)|node_modules|Turbopack/i.test(line), status: logStatus(message) });
  }
  for (const run of runs) {
    const message = redactBuildText(text(run.outputSummary) || text(run.inputSummary));
    if (message) logs.push({ timestamp: text(run.createdAt) || null, source: text(run.agentName) || "Agent", message, technical: /project=|local_build_/i.test(text(run.inputSummary)), status: logStatus(`${text(run.status)} ${message}`) });
  }
  logs.sort((a, b) => new Date(a.timestamp ?? createdAt).getTime() - new Date(b.timestamp ?? createdAt).getTime());

  const result: LiveBuildConsoleData = {
    active,
    project: {
      ...withCanonicalBuilderStage({
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
      }),
      canonicalStage,
    },
    timeline,
    logs: logs.slice(-160),
    files,
    preview: previewUrl ? { url: previewUrl, status: text(selected.localPreviewStatus) || "online", manualCommand: text(selected.localFolderPath) ? `cd "${redactBuildText(text(selected.localFolderPath))}"\nnpm run dev` : null } : null,
    worker: { status: workerStatus, lastHeartbeat: heartbeatAt || null },
    inspector: {
      currentStage: canonicalStage,
      currentStep: diagnosticStep ?? runningStep?.label ?? failedStep?.label ?? pendingStep?.label ?? "Completed",
      lastSuccessfulStep: completedSteps.at(-1)?.label ?? null,
      lastFailedStep: diagnosticStep ?? failedStep?.label ?? null,
      exactError: diagnostic ? redactBuildText(diagnostic.exactError) : null,
      failureCategory: diagnostic?.category ?? null,
      canRetry: failed && queueTasks.some((row) => text(row.status) === "failed"),
    },
  };
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { action?: string; projectId?: string } | null;
  if (body?.action !== "retry" || !body.projectId) return NextResponse.json({ error: "action=retry and projectId are required" }, { status: 400 });
  const client = db();
  const failed = await client.execute({
    sql: `SELECT id FROM AgentTask WHERE userId = ? AND project_id = ? AND status = 'failed' ORDER BY updatedAt DESC LIMIT 1`,
    args: [session.user.id, body.projectId],
  });
  const taskId = text((failed.rows[0] as unknown as Row | undefined)?.id);
  if (!taskId) return NextResponse.json({ error: "No failed execution task is available to retry. View logs for the recorded failure." }, { status: 409 });
  const task = await updateExecutionQueueTask(session.user.id, taskId, { status: "queued", error: null, result: null, log: "Retry requested from Project Inspector." });
  if (task) {
    await client.execute({
      sql: `UPDATE Project SET status = 'queued_for_local_worker', localBuildError = NULL, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
      args: [body.projectId, session.user.id],
    });
  }
  return NextResponse.json({ ok: Boolean(task), task });
}
