import { prisma } from "@/lib/db";
import {
  appendExecutionEvent,
  createExecutionRun,
  listExecutionEvents,
  listExecutionRuns,
  redactExecutionText,
  requestRunCancellation,
} from "@/lib/execution-runs";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || url.searchParams.get("token") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

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
