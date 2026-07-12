import { prisma } from "@/lib/db";
import { appendExecutionEvent } from "@/lib/execution-runs";
import { createApproval } from "@/lib/approvals";
import { getAgentRuntimeAdapter } from "./agent-runtime-registry";
import { evaluateAcceptanceCriteria } from "./acceptance-evaluator";
import { loadTaskExecutionContext } from "./task-context";
import { persistTaskArtifacts } from "./task-artifacts";
import {
  advanceProject,
  assignReadyTasks,
  handleTaskCompletion,
  handleTaskFailure,
  verifyProjectCompletion,
} from "./project-manager";

export type WakeupExecutionOutcome = {
  status: "completed" | "in_review" | "blocked" | "failed" | "awaiting_approval" | "skipped";
  wakeupId: string;
  projectId?: string;
  taskId?: string;
  runId?: string | null;
  artifactIds: string[];
  summary: string;
};

function terminalSummary(value: string): string {
  return value.slice(0, 1000);
}

async function blockersResolved(projectId: string, taskId: string): Promise<boolean> {
  const dependencies = await prisma.projectTaskDependency.findMany({ where: { projectId, taskId } });
  if (!dependencies.length) return true;
  const blockers = await prisma.projectTask.findMany({
    where: { id: { in: dependencies.map((dependency) => dependency.blockingTaskId) } },
    select: { id: true, status: true },
  });
  return blockers.length === dependencies.length && blockers.every((task) => task.status === "completed");
}

async function createFollowUpTasks(params: {
  userId: string;
  projectId: string;
  parentTaskId: string;
  tasks: Array<{ title: string; description?: string; assignedAgent: string; acceptanceCriteria?: string; outputContract?: string }>;
}) {
  for (const task of params.tasks) {
    await prisma.projectTask.create({
      data: {
        projectId: params.projectId,
        userId: params.userId,
        parentTaskId: params.parentTaskId,
        title: task.title,
        description: task.description ?? null,
        assignedAgent: task.assignedAgent,
        responsibleAgent: "project-manager",
        status: "ready",
        acceptanceCriteria: task.acceptanceCriteria ?? null,
        outputContract: task.outputContract ?? null,
        nextStep: "Created by autonomous review loop.",
      },
    });
  }
}

export async function executeClaimedWakeup(wakeupId: string): Promise<WakeupExecutionOutcome> {
  const wakeup = await prisma.agentWakeup.findUnique({ where: { id: wakeupId } });
  if (!wakeup) return { status: "skipped", wakeupId, artifactIds: [], summary: "Wakeup not found." };
  if (wakeup.status !== "claimed") return { status: "skipped", wakeupId, projectId: wakeup.projectId ?? undefined, taskId: wakeup.projectTaskId ?? undefined, runId: wakeup.runId, artifactIds: [], summary: `Wakeup is ${wakeup.status}, not claimed.` };
  if (!wakeup.projectId || !wakeup.projectTaskId || !wakeup.runId) {
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "failed", error: "Claimed wakeup is missing project/task/run linkage.", finishedAt: new Date() } });
    return { status: "failed", wakeupId, artifactIds: [], summary: "Claimed wakeup is missing project/task/run linkage." };
  }

  const [project, task, run] = await Promise.all([
    prisma.project.findUnique({ where: { id: wakeup.projectId } }),
    prisma.projectTask.findUnique({ where: { id: wakeup.projectTaskId } }),
    prisma.executionRun.findUnique({ where: { id: wakeup.runId } }),
  ]);
  if (!project || !task || !run) return { status: "failed", wakeupId, projectId: wakeup.projectId, taskId: wakeup.projectTaskId, runId: wakeup.runId, artifactIds: [], summary: "Missing project, task, or execution run." };
  if (["cancelled", "completed"].includes(project.phase ?? project.status) || task.status === "cancelled") {
    await appendExecutionEvent(run.id, { phase: "cancelled", source: "web", severity: "warning", message: "Wakeup execution skipped because project or task is cancelled.", status: "cancelled" });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "skipped", finishedAt: new Date(), error: "Project or task is cancelled." } });
    return { status: "skipped", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: [], summary: "Project or task is cancelled." };
  }
  if (task.assignedAgent !== wakeup.agentKey || task.activeRunId !== run.id) {
    await appendExecutionEvent(run.id, { phase: "failed", source: "web", severity: "error", message: "Wakeup ownership check failed.", status: "failed", lastSafeError: "Wakeup ownership check failed." });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "failed", finishedAt: new Date(), error: "Wakeup ownership check failed." } });
    return { status: "failed", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: [], summary: "Wakeup ownership check failed." };
  }
  if (!(await blockersResolved(project.id, task.id))) {
    await appendExecutionEvent(run.id, { phase: "waiting_for_worker", source: "web", severity: "warning", message: "Wakeup execution blocked because task blockers reopened.", status: "running" });
    await prisma.projectTask.update({ where: { id: task.id }, data: { status: "blocked", activeRunId: null, blockedReason: "Task blockers are not completed." } });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "skipped", finishedAt: new Date(), error: "Task blockers are not completed." } });
    await advanceProject(project.id);
    return { status: "blocked", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: [], summary: "Task blockers are not completed." };
  }

  const context = await loadTaskExecutionContext({ userId: wakeup.userId, wakeupId: wakeup.id, executionRunId: run.id });
  const adapter = getAgentRuntimeAdapter(wakeup.agentKey);
  if (!adapter) {
    await handleTaskFailure({ projectId: project.id, taskId: task.id, reason: `No runtime adapter registered for ${wakeup.agentKey}.` });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "failed", finishedAt: new Date(), error: `No runtime adapter registered for ${wakeup.agentKey}.` } });
    return { status: "failed", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: [], summary: `No runtime adapter registered for ${wakeup.agentKey}.` };
  }

  await appendExecutionEvent(run.id, {
    phase: "initializing",
    source: "web",
    severity: "info",
    message: `Loaded task context for ${wakeup.agentKey}.`,
    safeDetails: { projectId: project.id, taskId: task.id, planId: context.planId, skills: context.approvedSkills.map((skill) => skill.id) },
    status: "running",
  });
  await prisma.executionRun.update({
    where: { id: run.id },
    data: { status: "running", currentPhase: "planning", currentActivity: `Invoking ${wakeup.agentKey} runtime adapter.` },
  });
  const readiness = await adapter.canHandle(context);
  await appendExecutionEvent(run.id, {
    phase: "planning",
    source: "web",
    severity: readiness.ready ? "info" : "warning",
    message: readiness.reason,
    meaningful: true,
  });
  const result = readiness.ready
    ? await adapter.execute(context)
    : {
        status: "blocked" as const,
        summary: readiness.reason,
        artifacts: [{
          type: "completion_report" as const,
          title: "Runtime readiness blocker",
          summary: readiness.reason,
          content: `Agent ${wakeup.agentKey} could not execute task "${task.title}".\n\nReason: ${readiness.reason}`,
        }],
        evidence: [],
        blocker: { type: "runtime_not_ready", reason: readiness.reason },
      };

  await appendExecutionEvent(run.id, {
    phase: "hermes_nous_running",
    source: "web",
    severity: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "info",
    message: result.summary,
    safeDetails: { status: result.status, artifactCount: result.artifacts.length, evidenceCount: result.evidence.length },
    meaningful: true,
  });
  const artifacts = await persistTaskArtifacts({
    userId: wakeup.userId,
    projectId: project.id,
    projectTaskId: task.id,
    executionRunId: run.id,
    wakeupId: wakeup.id,
    agentKey: wakeup.agentKey,
    artifacts: result.artifacts,
  });
  const evaluation = evaluateAcceptanceCriteria({
    criteria: context.acceptanceCriteria,
    outputContract: context.outputContract,
    evidence: result.evidence,
    artifactIds: artifacts.map((artifact) => artifact.id),
    status: result.status,
  });

  if (result.approvalRequest) {
    await createApproval(wakeup.userId, result.approvalRequest.actionType, result.approvalRequest.payload).catch(() => null);
  }
  if (result.followUpTasks?.length) {
    await createFollowUpTasks({ userId: wakeup.userId, projectId: project.id, parentTaskId: task.id, tasks: result.followUpTasks });
  }

  if (result.status === "blocked") {
    await prisma.projectTask.update({
      where: { id: task.id },
      data: { status: "blocked", activeRunId: null, blockedReason: terminalSummary(result.blocker?.reason ?? result.summary), nextStep: `Blocked: ${terminalSummary(result.summary)}` },
    });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "finished", finishedAt: new Date(), error: result.blocker?.reason ?? null } });
    await appendExecutionEvent(run.id, { phase: "completed", source: "web", severity: "warning", message: "Wakeup finished with blocked task state.", status: "completed" });
    await advanceProject(project.id);
    return { status: "blocked", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: artifacts.map((artifact) => artifact.id), summary: result.summary };
  }
  if (result.status === "failed" || !evaluation.complete) {
    const reason = result.status === "failed"
      ? result.summary
      : evaluation.results.filter((item) => item.status !== "passed").map((item) => item.reason).join("; ");
    await handleTaskFailure({ projectId: project.id, taskId: task.id, reason: terminalSummary(reason || "Acceptance criteria were not proven.") });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "failed", finishedAt: new Date(), error: terminalSummary(reason || "Acceptance criteria were not proven.") } });
    await appendExecutionEvent(run.id, { phase: "failed", source: "web", severity: "error", message: terminalSummary(reason || "Acceptance criteria were not proven."), status: "failed", lastSafeError: reason });
    return { status: "failed", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: artifacts.map((artifact) => artifact.id), summary: reason || "Acceptance criteria were not proven." };
  }
  if (result.status === "in_review" || result.followUpTasks?.length) {
    await prisma.projectTask.update({
      where: { id: task.id },
      data: { status: "in_review", activeRunId: null, nextStep: `Evidence: ${JSON.stringify({ summary: result.summary, artifactIds: artifacts.map((artifact) => artifact.id), evaluation: evaluation.results }).slice(0, 900)}` },
    });
    await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "finished", finishedAt: new Date(), error: null } });
    await appendExecutionEvent(run.id, { phase: "completed", source: "web", severity: "info", message: "Wakeup finished and task moved to review.", status: "completed" });
    await assignReadyTasks(project.id);
    await advanceProject(project.id);
    return { status: "in_review", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: artifacts.map((artifact) => artifact.id), summary: result.summary };
  }

  await handleTaskCompletion({
    projectId: project.id,
    taskId: task.id,
    evidence: { summary: result.summary, artifactIds: artifacts.map((artifact) => artifact.id), evaluation: evaluation.results },
  });
  await prisma.agentWakeup.update({ where: { id: wakeup.id }, data: { status: "finished", finishedAt: new Date(), error: null } });
  await appendExecutionEvent(run.id, { phase: "completed", source: "web", severity: "info", message: "Wakeup execution completed with accepted evidence.", status: "completed" });
  await verifyProjectCompletion(project.id);
  return { status: "completed", wakeupId, projectId: project.id, taskId: task.id, runId: run.id, artifactIds: artifacts.map((artifact) => artifact.id), summary: result.summary };
}
