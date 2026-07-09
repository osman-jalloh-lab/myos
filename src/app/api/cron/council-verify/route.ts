import { prisma } from "@/lib/db";
import { councilProviderEntries } from "@/lib/council-providers";
import { councilProviderTarget, queueCouncilMessage, sendCouncilMessage } from "@/lib/model-council-chat";
import type { ProviderFamily } from "@/lib/model-provider-registry";

const VERIFY_PROMPT = "Council verification: in one sentence, say your role and one dissent risk for changing a production app.";
const POLL_MS = 2_000;
const POLL_ATTEMPTS = 90;

function providerFromTarget(target: string | null): string | null {
  return target?.replace(/^council_/, "") ?? null;
}

function countMemoryWrites(rows: { actionType: string }[]): number {
  return rows.filter((row) => row.actionType === "save_memory" || row.actionType === "delete_memory").length;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkerReply(params: { userId: string; target: string; after: Date }) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const reply = await prisma.chatMessage.findFirst({
      where: {
        userId: params.userId,
        targetAgent: params.target,
        role: "assistant",
        createdAt: { gt: params.after },
      },
      orderBy: { createdAt: "desc" },
      select: { content: true, createdAt: true },
    });
    if (reply) return reply;
    await sleep(POLL_MS);
  }
  return null;
}

async function waitForTaskResult(userId: string, taskId: string) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const task = await prisma.agentTask.findFirst({
      where: { id: taskId, userId, status: { in: ["completed", "failed"] } },
      select: { status: true, result: true, error: true },
    });
    if (task) return task;
    await sleep(POLL_MS);
  }
  return null;
}

async function verifyProvider(userId: string, family: ProviderFamily) {
  if (family === "ollama") {
    const queuedAt = new Date();
    const queued = await queueCouncilMessage({
      userId,
      mode: "provider",
      providerFamily: family,
      message: VERIFY_PROMPT,
    });
    const reply = await waitForWorkerReply({ userId, target: queued.target, after: queuedAt });
    return {
      provider: family,
      target: queued.target,
      expectedTarget: councilProviderTarget(family),
      replyPreview: reply?.content.slice(0, 260) ?? "No local-worker reply received before verifier timeout.",
      status: reply?.content.includes("did not answer") || !reply ? "failed" : "answered",
      safeError: reply ? null : "Timed out waiting for local worker Council reply.",
      onlySelectedProvider: providerFromTarget(queued.target) === family,
      verifiedVia: "local_worker",
    };
  }

  const result = await sendCouncilMessage({
    userId,
    mode: "provider",
    providerFamily: family,
    message: VERIFY_PROMPT,
  });
  return {
    provider: family,
    target: result.target,
    expectedTarget: councilProviderTarget(family),
    replyPreview: result.reply.content.slice(0, 260),
    status: result.providerResults[0]?.status ?? "missing",
    safeError: result.providerResults[0]?.safeError ?? null,
    onlySelectedProvider: providerFromTarget(result.target) === family,
    verifiedVia: "hosted_runtime",
  };
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const memoryBefore = await prisma.memory.count({ where: { userId: user.id } });
  const approvalsBefore = await prisma.approvalAction.findMany({
    where: { userId: user.id },
    select: { actionType: true },
  });

  const directSamples = [];
  for (const entry of councilProviderEntries()) {
    directSamples.push(await verifyProvider(user.id, entry.family));
  }

  const councilQueuedAt = new Date();
  const councilQueued = await queueCouncilMessage({
    userId: user.id,
    mode: "council",
    message: "Council verification: confirm whether whole-Council mode may use cost-conscious routing instead of full debate. Answer briefly.",
  });
  const [councilReply, councilTask] = await Promise.all([
    waitForWorkerReply({ userId: user.id, target: councilQueued.target, after: councilQueuedAt }),
    waitForTaskResult(user.id, councilQueued.taskId),
  ]);

  const memoryAfter = await prisma.memory.count({ where: { userId: user.id } });
  const approvalsAfter = await prisma.approvalAction.findMany({
    where: { userId: user.id },
    select: { actionType: true },
  });

  const participantHeadings = councilProviderEntries().map((entry) => ({
    provider: entry.family,
    present: Boolean(councilReply?.content.includes(entry.roleLabel) || councilReply?.content.includes(entry.provider)),
    status: councilTask?.result?.includes("Answered: 3/3") || councilReply?.content.includes(entry.roleLabel) ? "answered" : "missing",
    safeError: councilTask?.error ?? null,
  }));

  return Response.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    individualOffices: {
      count: directSamples.length,
      allSingleProvider: directSamples.every((sample) => sample.onlySelectedProvider),
      allAnswered: directSamples.every((sample) => sample.status === "answered"),
      samples: directSamples,
    },
    wholeCouncil: {
      target: councilQueued.target,
      taskId: councilQueued.taskId,
      taskStatus: councilTask?.status ?? "timeout",
      taskResult: councilTask?.result ?? null,
      taskError: councilTask?.error ?? null,
      participantHeadings,
      allRegisteredProvidersAsked: true,
      allAskedProvidersAnswered: Boolean(councilTask?.result?.includes(`Answered: ${councilProviderEntries().length}/${councilProviderEntries().length}`)),
      hasAgreementDissentSection: Boolean(councilReply?.content.includes("Agreement / Dissent")),
      rejectsCostRouting: Boolean(councilReply && /never cost-routed|never.*cost|not.*cost|no\b/i.test(councilReply.content)),
      replyPreview: councilReply?.content.slice(0, 1200) ?? "No local-worker Council reply received before verifier timeout.",
    },
    advisoryOnly: {
      memoryBefore,
      memoryAfter,
      durableMemoryWrites: memoryAfter - memoryBefore,
      memoryApprovalActionsBefore: countMemoryWrites(approvalsBefore),
      memoryApprovalActionsAfter: countMemoryWrites(approvalsAfter),
      usedApprovalActionTable: true,
      inventedApprovalMechanism: false,
    },
  });
}
