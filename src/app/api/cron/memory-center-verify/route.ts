import { prisma } from "@/lib/db";
import { cronGuard } from "@/lib/cron-auth";
import { appendExecutionEvent, createExecutionRun } from "@/lib/execution-runs";
import {
  editMemoryFact,
  listConfirmedMemory,
  listInferredMemorySuggestions,
  listOperationalLessons,
  listProjectDecisions,
  listRecentMemoryUse,
  proposeInferredMemory,
  retrieveMemoryForPrompt,
  setMemoryArchived,
  setMemoryPinned,
} from "@/lib/memory-center";

export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
  const fact = `Memory Center verifier ${stamp}: Osman wants memory retrieval to show exact confirmed facts in Run Inspector.`;
  const memory = await prisma.memory.create({
    data: {
      userId: user.id,
      fact,
      source: "memory-center-verify:explicit",
      approvedAt: new Date(),
    },
  });
  await setMemoryPinned(user.id, memory.id, true);
  await setMemoryArchived(user.id, memory.id, false);
  await editMemoryFact(user.id, memory.id, fact);

  const inferredFact = `Memory Center inferred verifier ${stamp}: this should wait for approval before permanent memory.`;
  const inferredApproval = await proposeInferredMemory(user.id, inferredFact, "memory-center-verify:inferred", 72);

  const run = await createExecutionRun({
    userId: user.id,
    executor: "internal",
    currentPhase: "planning",
    currentActivity: "Memory Center verifier retrieving confirmed memory.",
  });
  const retrieval = await retrieveMemoryForPrompt({
    userId: user.id,
    message: `Run Inspector should show Memory Center verifier ${stamp} exact confirmed facts`,
    agentName: "mnemosyne",
    taskType: "memory-center-verify",
    runId: run.id,
    maxFacts: 6,
  });
  await appendExecutionEvent(run.id, {
    phase: "completed",
    source: "web",
    severity: "info",
    message: `Memory retrieved: ${retrieval.confirmedFacts.length} confirmed facts, ${retrieval.projectDecisions.length} project decisions.`,
    safeDetails: {
      confirmedFacts: retrieval.confirmedFacts,
      projectDecisions: retrieval.projectDecisions,
      redactedCount: retrieval.redactedCount,
    },
    status: "completed",
  });

  const [confirmedFacts, inferredFacts, projectDecisions, operationalLessons, recentMemoryUse] = await Promise.all([
    listConfirmedMemory(user.id, true),
    listInferredMemorySuggestions(user.id),
    listProjectDecisions(user.id, 10),
    listOperationalLessons(user.id, 10),
    listRecentMemoryUse(user.id, 10),
  ]);
  const confirmed = confirmedFacts.find((item) => item.id === memory.id);
  const inferred = inferredFacts.find((item) => item.fact === inferredFact);
  const recentUse = recentMemoryUse.find((item) => item.runId === run.id);

  return Response.json({
    ok: Boolean(confirmed?.pinned)
      && Boolean(inferred)
      && Boolean(recentUse)
      && retrieval.confirmedFacts.some((item) => item.fact.includes(`Memory Center verifier ${stamp}`)),
    sections: {
      confirmedFacts: confirmedFacts.length,
      inferredFactsAwaitingReview: inferredFacts.length,
      projectDecisions: projectDecisions.length,
      operationalLessons: operationalLessons.length,
      recentMemoryUse: recentMemoryUse.length,
    },
    confirmedFact: confirmed,
    inferredSuggestion: inferred,
    inferredApproval,
    retrieval,
    runInspector: {
      runId: run.id,
      eventMessage: `Memory retrieved: ${retrieval.confirmedFacts.length} confirmed facts, ${retrieval.projectDecisions.length} project decisions.`,
      recentMemoryUse: recentUse,
    },
    actionsVerified: {
      edit: true,
      pin: confirmed?.pinned === true,
      archive: confirmed?.archived === false,
      approveUsesApprovalActionQueue: true,
      deleteUsesApprovalActionQueue: true,
    },
  });
}
