import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import {
  appendExecutionEvent,
  createExecutionRun,
  listExecutionEvents,
  listExecutionRuns,
  redactExecutionText,
  requestRunCancellation,
} from "@/lib/execution-runs";
import { createExecutionQueueTask } from "@/lib/execution-queue";
import { DEFAULT_LOCAL_PROJECTS_ROOT } from "@/lib/local-projects-root";

const POLL_MS = 8_000;
const POLL_ATTEMPTS = 10;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || url.searchParams.get("token") === secret;
}

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyAutomaticFallback(userId: string) {
  const db = getDb();
  const projectId = crypto.randomUUID();
  const projectName = `Run Inspector Auto Fallback ${projectId.slice(0, 8)}`;
  const localFolderPath = `${DEFAULT_LOCAL_PROJECTS_ROOT}\\run-inspector-auto-fallback-${projectId.slice(0, 8)}`;
  await db.execute({
    sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, localFolderPath, localBuildLog, localBuildError, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 'queued_for_local_worker', ?, 'hermes_agent', ?, ?, NULL, datetime('now'), datetime('now'))`,
    args: [
      projectId,
      userId,
      projectName,
      null,
      "ForceHermesNousFailureForVerifier: true",
      localFolderPath,
      "Run Inspector verifier queued a forced Hermes Nous failure for automatic Codex fallback.\n",
    ],
  });
  const task = await createExecutionQueueTask({
    userId,
    title: `Auto fallback verifier for ${projectName}`,
    description: [
      "Action: stopDev",
      `Project: ${projectName}`,
      `Local folder: ${localFolderPath}`,
      "Message: ForceHermesNousFailureForVerifier: true",
      "Run this from the local worker; serverless runtime must not execute local filesystem or process actions.",
    ].join("\n"),
    priority: "high",
    assignedExecutor: "hermes_agent",
    projectId,
    initialLog: "Verifier queued forced Hermes Nous failure; automatic Codex fallback must recover without approval.",
  });
  const run = await createExecutionRun({
    userId,
    projectId,
    taskId: task.id,
    executor: "hermes_agent",
    currentPhase: "queued",
    currentActivity: "Auto fallback verifier queued.",
    localFolderPath,
  });

  let finalTask: Record<string, unknown> | null = null;
  let events = await listExecutionEvents(userId, run.id, 80);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const taskRows = await db.execute({
      sql: `SELECT id, status, result, error, logs FROM AgentTask WHERE id = ? AND userId = ? LIMIT 1`,
      args: [task.id, userId],
    });
    finalTask = taskRows.rows[0] as Record<string, unknown> | undefined ?? null;
    events = await listExecutionEvents(userId, run.id, 80);
    const status = String(finalTask?.status ?? "");
    const hasFallback = events?.some((event) => event.phase === "codex_fallback_running" && /Automatically fell back to Codex/i.test(event.message));
    if (hasFallback && ["completed", "qa_passed", "qa_pending", "failed"].includes(status)) break;
    await sleep(POLL_MS);
  }
  const latestRun = await listExecutionRuns(userId, 20).then((runs) => runs.find((item) => item.id === run.id) ?? null);
  const fallbackEvent = events?.find((event) => event.phase === "codex_fallback_running" && /Automatically fell back to Codex/i.test(event.message)) ?? null;
  return {
    ok: Boolean(fallbackEvent && finalTask && String(finalTask.status) === "completed" && latestRun?.status === "completed"),
    run: latestRun,
    task: finalTask ? {
      id: finalTask.id,
      status: finalTask.status,
      result: finalTask.result,
      error: finalTask.error,
    } : null,
    fallbackEvent,
    events,
  };
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const url = new URL(req.url);
  if (url.searchParams.get("mode") === "autoFallback") {
    const result = await verifyAutomaticFallback(user.id);
    return Response.json(result, { status: result.ok ? 200 : 500 });
  }

  const run = await createExecutionRun({
    userId: user.id,
    executor: "internal",
    currentPhase: "queued",
    currentActivity: "Run Inspector live verification queued.",
  });
  await appendExecutionEvent(run.id, {
    phase: "claimed",
    source: "local_worker",
    message: "Verifier claimed the run.",
    safeDetails: { commandCategory: "verifier_claim", token: "OPENAI_API_KEY=sk-live-should-redact-1234567890" },
    workerId: "verifier",
  });
  await appendExecutionEvent(run.id, {
    phase: "planning",
    source: "local_worker",
    message: "Verifier recorded planning progress.",
    safeDetails: { linesCaptured: 120, boundedLogLines: "120/200" },
  });
  await appendExecutionEvent(run.id, {
    phase: "completed",
    source: "local_worker",
    message: "Run Inspector live verification completed.",
    safeDetails: { commandCategory: "verifier_complete", rawCommandStored: false },
    status: "completed",
  });

  const cancelRun = await createExecutionRun({
    userId: user.id,
    executor: "internal",
    currentPhase: "queued",
    currentActivity: "Cancellation request verifier queued.",
  });
  const requested = await requestRunCancellation(user.id, cancelRun.id);
  const [runs, events, cancelEvents] = await Promise.all([
    listExecutionRuns(user.id, 10),
    listExecutionEvents(user.id, run.id, 20),
    listExecutionEvents(user.id, cancelRun.id, 20),
  ]);
  const serializedEvents = JSON.stringify(events);
  const redactionProbe = redactExecutionText("Authorization: Bearer abc.def.ghi OPENAI_API_KEY=sk-live-should-redact-1234567890");

  return Response.json({
    ok: Boolean(
      runs.some((item) => item.id === run.id && item.status === "completed")
      && events?.some((event) => event.phase === "claimed")
      && events?.some((event) => event.phase === "planning")
      && events?.some((event) => event.phase === "completed")
      && requested?.status === "running"
      && requested.currentPhase === "waiting_for_worker"
      && !serializedEvents.includes("sk-live-should-redact")
      && redactionProbe.includes("[redacted]")
    ),
    run: runs.find((item) => item.id === run.id),
    events,
    cancellationRequest: {
      runId: cancelRun.id,
      status: requested?.status,
      currentPhase: requested?.currentPhase,
      message: cancelEvents?.at(-1)?.message,
    },
    redactionProbe,
  });
}
