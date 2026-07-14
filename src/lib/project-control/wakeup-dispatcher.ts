import { prisma } from "@/lib/db";
import { claimReadyProjectTask, handleTaskCompletion, handleTaskFailure } from "./project-manager";
import { executeClaimedWakeup } from "./wakeup-executor";

export type WakeupDispatchResult = {
  checked: number;
  claimed: Array<{ wakeupId: string; taskId: string | null; runId: string | null; agentKey: string }>;
  skipped: Array<{ wakeupId: string; reason: string }>;
};

export const MAX_WAKEUPS_PER_DISPATCH = 5;
export const MAX_PROJECT_TRANSITIONS_PER_RUN = 20;
export const MAX_TASK_DEPTH = 8;

export async function claimWakeup(wakeupId: string, userId: string) {
  const wakeup = await prisma.agentWakeup.findFirst({
    where: { id: wakeupId, userId, status: "queued" },
  });
  if (!wakeup) return { status: "not_available" as const, wakeup: null, run: null };
  if (!wakeup.projectId || !wakeup.projectTaskId) {
    await prisma.agentWakeup.update({
      where: { id: wakeupId },
      data: { status: "failed", error: "Wakeup has no linked project task.", finishedAt: new Date() },
    });
    return { status: "invalid" as const, wakeup, run: null };
  }

  const task = await prisma.projectTask.findUnique({ where: { id: wakeup.projectTaskId } });
  if (!task || task.status !== "ready") {
    await prisma.agentWakeup.update({
      where: { id: wakeup.id },
      data: { status: "skipped", error: `Linked task is not runnable (${task?.status ?? "missing"}).`, finishedAt: new Date() },
    });
    return { status: "task_not_runnable" as const, wakeup, run: null };
  }

  const claim = await claimReadyProjectTask({
    userId,
    projectId: wakeup.projectId,
    taskId: wakeup.projectTaskId,
    agentKey: wakeup.agentKey,
    executor: `agent:${wakeup.agentKey}`,
  });
  if (claim.status !== "claimed" || !claim.run) {
    await prisma.agentWakeup.update({
      where: { id: wakeup.id },
      data: { status: "skipped", error: claim.status, finishedAt: new Date() },
    });
    return { status: claim.status, wakeup, run: null };
  }

  const claimed = await prisma.agentWakeup.update({
    where: { id: wakeup.id },
    data: { status: "claimed", claimedAt: new Date(), runId: claim.run.id },
  });
  await prisma.projectTask.update({
    where: { id: wakeup.projectTaskId },
    data: { status: "running", activeRunId: claim.run.id },
  });
  return { status: "claimed" as const, wakeup: claimed, run: claim.run };
}

export async function finishWakeup(wakeupId: string, evidence: Record<string, unknown>) {
  const wakeup = await prisma.agentWakeup.findUniqueOrThrow({ where: { id: wakeupId } });
  if (!wakeup.projectId || !wakeup.projectTaskId) throw new Error("Wakeup is not linked to a project task.");
  await handleTaskCompletion({ projectId: wakeup.projectId, taskId: wakeup.projectTaskId, evidence });
  return prisma.agentWakeup.update({
    where: { id: wakeupId },
    data: { status: "finished", finishedAt: new Date(), error: null },
  });
}

export async function failWakeup(wakeupId: string, reason: string) {
  const wakeup = await prisma.agentWakeup.findUniqueOrThrow({ where: { id: wakeupId } });
  if (wakeup.projectId && wakeup.projectTaskId) {
    await handleTaskFailure({ projectId: wakeup.projectId, taskId: wakeup.projectTaskId, reason });
  }
  return prisma.agentWakeup.update({
    where: { id: wakeupId },
    data: { status: "failed", finishedAt: new Date(), error: reason.slice(0, 1000) },
  });
}

export async function dispatchQueuedWakeups(params: {
  userId: string;
  projectId?: string;
  limit?: number;
  execute?: boolean;
}): Promise<WakeupDispatchResult> {
  const wakeups = await prisma.agentWakeup.findMany({
    where: {
      userId: params.userId,
      status: "queued",
      ...(params.projectId ? { projectId: params.projectId } : {}),
    },
    orderBy: { requestedAt: "asc" },
    take: Math.min(params.limit ?? MAX_WAKEUPS_PER_DISPATCH, MAX_WAKEUPS_PER_DISPATCH),
  });
  const result: WakeupDispatchResult = { checked: wakeups.length, claimed: [], skipped: [] };
  for (const wakeup of wakeups) {
    const claim = await claimWakeup(wakeup.id, params.userId);
    if (claim.status === "claimed") {
      if (params.execute !== false) await executeClaimedWakeup(wakeup.id).catch(async (error) => {
        await prisma.agentWakeup.update({
          where: { id: wakeup.id },
          data: { status: "failed", finishedAt: new Date(), error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) },
        }).catch(() => undefined);
      });
      result.claimed.push({
        wakeupId: wakeup.id,
        taskId: wakeup.projectTaskId,
        runId: claim.run?.id ?? null,
        agentKey: wakeup.agentKey,
      });
    } else {
      result.skipped.push({ wakeupId: wakeup.id, reason: claim.status });
    }
  }
  return result;
}
