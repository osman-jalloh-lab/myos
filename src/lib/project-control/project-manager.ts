import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import {
  createDeterministicProjectPlan,
  resolveCapabilities,
  type CouncilDecision,
  type PlannedProjectTask,
  type ProposedProjectPlan,
} from "./project-planner";
import {
  nextProjectPhase,
  taskBlockedByUnfinishedDependencies,
  taskWakeupIdempotencyKey,
  type ProjectPhase,
} from "./project-state-machine";

type JsonRecord = Record<string, unknown>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function taskFingerprint(projectId: string, planId: string, tasks: PlannedProjectTask[]): string {
  return crypto.createHash("sha256").update(`${projectId}:${planId}:${json(tasks)}`).digest("hex");
}

function planBody(plan: ProposedProjectPlan): string {
  return json({
    title: plan.title,
    summary: plan.summary,
    requiredCapabilities: plan.requiredCapabilities,
    tasks: plan.tasks,
  });
}

export async function createProposedProjectPlan(params: {
  userId: string;
  request: string;
  councilDecision?: CouncilDecision | null;
}) {
  const proposed = createDeterministicProjectPlan(params.request, params.councilDecision ?? null);
  const project = await prisma.project.create({
    data: {
      userId: params.userId,
      projectName: proposed.title,
      description: proposed.summary,
      latestInstruction: params.request,
      assignedAgent: "project-manager",
      status: "planning",
      phase: proposed.needsCouncil ? "council_review" : "awaiting_plan_approval",
      requestFingerprint: proposed.requestFingerprint,
    },
  });
  const plan = await prisma.projectPlan.create({
    data: {
      projectId: project.id,
      revision: 1,
      status: "proposed",
      body: planBody(proposed),
      decisionSnapshot: params.councilDecision ? json(params.councilDecision) : null,
      requestFingerprint: proposed.requestFingerprint,
      createdByAgent: "project-manager",
    },
  });
  return { project, plan, proposed };
}

export async function startProjectFromDecision(params: {
  userId: string;
  request: string;
  decision: CouncilDecision;
}) {
  const created = await createProposedProjectPlan({
    userId: params.userId,
    request: params.request,
    councilDecision: params.decision,
  });
  await prisma.project.update({
    where: { id: created.project.id },
    data: { phase: params.decision.needsUserChoice ? "awaiting_user_choice" : "awaiting_plan_approval" },
  });
  return created;
}

export async function acceptProjectPlan(params: {
  userId: string;
  projectId: string;
  planId: string;
}) {
  const plan = await prisma.projectPlan.findFirstOrThrow({
    where: { id: params.planId, projectId: params.projectId },
  });
  if (plan.status === "accepted") return plan;
  const accepted = await prisma.projectPlan.update({
    where: { id: params.planId },
    data: { status: "accepted", acceptedByUserId: params.userId, acceptedAt: new Date() },
  });
  await prisma.project.update({
    where: { id: params.projectId },
    data: { latestPlanId: accepted.id, phase: "planning", status: "planning" },
  });
  return accepted;
}

async function createWakeup(params: {
  userId: string;
  projectId: string;
  taskId: string;
  agentKey: string;
  source: string;
  reason: string;
  payload?: JsonRecord;
  taskVersion: string | number | Date;
}) {
  const idempotencyKey = taskWakeupIdempotencyKey({
    projectId: params.projectId,
    taskId: params.taskId,
    agentKey: params.agentKey,
    reason: params.reason,
    taskVersion: params.taskVersion,
  });
  return prisma.agentWakeup.upsert({
    where: { idempotencyKey },
    create: {
      userId: params.userId,
      projectId: params.projectId,
      projectTaskId: params.taskId,
      agentKey: params.agentKey,
      source: params.source,
      reason: params.reason,
      payload: params.payload ? json(params.payload) : null,
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "project-manager",
    },
    update: {
      coalescedCount: { increment: 1 },
      updatedAt: new Date(),
    },
  });
}

export async function decomposeAcceptedPlan(params: {
  userId: string;
  projectId: string;
  planId: string;
  ownerRunId?: string | null;
}) {
  const plan = await prisma.projectPlan.findFirstOrThrow({
    where: { id: params.planId, projectId: params.projectId, status: "accepted" },
  });
  const existing = await prisma.projectPlanDecomposition.findUnique({
    where: { projectId_planId: { projectId: params.projectId, planId: params.planId } },
  });
  if (existing) return existing;

  const body = parseJson<{ tasks: PlannedProjectTask[]; requiredCapabilities?: unknown[] }>(plan.body, { tasks: [] });
  const tasks = body.tasks ?? [];
  const fingerprint = taskFingerprint(params.projectId, params.planId, tasks);
  const createdIds: string[] = [];
  const titleToId = new Map<string, string>();

  const decomposition = await prisma.$transaction(async (tx) => {
    for (const task of tasks) {
      const row = await tx.projectTask.create({
        data: {
          projectId: params.projectId,
          userId: params.userId,
          title: task.title,
          description: task.description ?? null,
          assignedAgent: task.assignedAgent ?? "project-manager",
          responsibleAgent: task.responsibleAgent ?? "project-manager",
          priority: task.priority ?? "medium",
          acceptanceCriteria: task.acceptanceCriteria ?? null,
          requiredCapabilities: task.requiredCapabilities ? json(task.requiredCapabilities) : null,
          outputContract: task.outputContract ?? null,
          status: task.dependsOn?.length ? "backlog" : "ready",
          nextStep: "Awaiting Project Manager advancement",
        },
      });
      createdIds.push(row.id);
      titleToId.set(task.title, row.id);
    }

    for (const task of tasks) {
      const taskId = titleToId.get(task.title);
      if (!taskId) continue;
      for (const dependencyTitle of task.dependsOn ?? []) {
        const blockingTaskId = titleToId.get(dependencyTitle);
        if (!blockingTaskId) continue;
        await tx.projectTaskDependency.create({
          data: { projectId: params.projectId, taskId, blockingTaskId },
        });
      }
    }

    return tx.projectPlanDecomposition.create({
      data: {
        projectId: params.projectId,
        planId: params.planId,
        status: "completed",
        requestedTasks: json(tasks),
        createdTaskIds: json(createdIds),
        ownerAgent: "project-manager",
        ownerRunId: params.ownerRunId ?? null,
        fingerprint,
        completedAt: new Date(),
      },
    });
  });

  await assignReadyTasks(params.projectId);
  await advanceProject(params.projectId);
  return decomposition;
}

export async function assignReadyTasks(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const [tasks, dependencies] = await Promise.all([
    prisma.projectTask.findMany({ where: { projectId, status: { in: ["backlog", "ready"] } } }),
    prisma.projectTaskDependency.findMany({ where: { projectId } }),
  ]);
  const blocked = taskBlockedByUnfinishedDependencies(dependencies, await prisma.projectTask.findMany({ where: { projectId } }));
  const wakeups = [];
  for (const task of tasks) {
    if (blocked.has(task.id)) continue;
    const updated = task.status === "ready"
      ? task
      : await prisma.projectTask.update({
          where: { id: task.id },
          data: { status: "ready", blockedReason: null },
        });
    const agentKey = updated.assignedAgent ?? updated.responsibleAgent ?? "project-manager";
    wakeups.push(await createWakeup({
      userId: project.userId,
      projectId,
      taskId: updated.id,
      agentKey,
      source: "project-manager",
      reason: "task_ready",
      payload: { title: updated.title, acceptanceCriteria: updated.acceptanceCriteria },
      taskVersion: updated.updatedAt ?? Date.now(),
    }));
  }
  return wakeups;
}

export async function claimReadyProjectTask(params: {
  userId: string;
  projectId: string;
  taskId: string;
  agentKey: string;
  executor?: string;
}) {
  const blockers = await prisma.projectTaskDependency.count({
    where: {
      projectId: params.projectId,
      taskId: params.taskId,
      NOT: { blockingTaskId: "" },
      blockingTaskId: {
        in: (await prisma.projectTask.findMany({
          where: { projectId: params.projectId, status: { not: "completed" } },
          select: { id: true },
        })).map((task) => task.id),
      },
    },
  });
  if (blockers > 0) return { status: "blocked" as const, run: null };

  const runId = crypto.randomUUID();
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.projectTask.updateMany({
      where: {
        id: params.taskId,
        projectId: params.projectId,
        status: "ready",
        assignedAgent: params.agentKey,
        activeRunId: null,
      },
      data: {
        status: "claimed",
        claimedRunId: runId,
        activeRunId: runId,
        executionLockedAt: new Date(),
        startedAt: new Date(),
        attemptCount: { increment: 1 },
      },
    });
    if (updated.count !== 1) return null;
    return tx.executionRun.create({
      data: {
        id: runId,
        userId: params.userId,
        projectId: params.projectId,
        taskId: params.taskId,
        executor: params.executor ?? params.agentKey,
        currentPhase: "claimed",
        currentActivity: "Project task claimed atomically.",
        status: "running",
      },
    });
  });
  return result ? { status: "claimed" as const, run: result } : { status: "already_claimed" as const, run: null };
}

export async function handleTaskCompletion(params: {
  projectId: string;
  taskId: string;
  evidence: JsonRecord;
}) {
  if (!Object.keys(params.evidence).length) throw new Error("Task completion requires evidence.");
  const task = await prisma.projectTask.update({
    where: { id: params.taskId },
    data: {
      status: "completed",
      completedAt: new Date(),
      activeRunId: null,
      blockedReason: null,
      nextStep: `Evidence: ${json(params.evidence).slice(0, 300)}`,
    },
  });
  await assignReadyTasks(params.projectId);
  await advanceProject(params.projectId);
  return task;
}

export async function handleTaskFailure(params: {
  projectId: string;
  taskId: string;
  reason: string;
}) {
  const task = await prisma.projectTask.findUniqueOrThrow({ where: { id: params.taskId } });
  const nextStatus = task.attemptCount + 1 >= task.maxAttempts ? "failed" : "blocked";
  const updated = await prisma.projectTask.update({
    where: { id: params.taskId },
    data: {
      status: nextStatus,
      activeRunId: null,
      blockedReason: params.reason.slice(0, 1000),
      nextStep: nextStatus === "failed" ? "Return to Project Manager for replanning." : "Retry after Project Manager review.",
    },
  });
  await advanceProject(params.projectId);
  return updated;
}

export async function verifyProjectCompletion(projectId: string) {
  const [project, tasks] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.projectTask.findMany({ where: { projectId } }),
  ]);
  const required = tasks.filter((task) => task.status !== "cancelled");
  const completionEvidenceCount = required.filter((task) => task.completedAt && task.nextStep?.includes("Evidence:")).length;
  const complete = required.length > 0 && required.every((task) => task.status === "completed") && completionEvidenceCount === required.length;
  if (!complete) return { complete: false, project };
  if (project.completedAt && project.completionEvidence) return { complete: true, project };
  const completedAt = new Date();
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: {
      phase: "completed",
      status: "completed",
      completedAt,
      completionEvidence: json({ taskCount: required.length, completedAt: completedAt.toISOString() }),
    },
  });
  return { complete: true, project: updated };
}

export async function advanceProject(projectId: string): Promise<ProjectPhase> {
  const [project, acceptedPlan, tasks, gaps] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.projectPlan.findFirst({ where: { projectId, status: "accepted" }, orderBy: { revision: "desc" } }),
    prisma.projectTask.findMany({ where: { projectId } }),
    prisma.capabilityGap.findMany({ where: { projectId, status: { notIn: ["resolved", "armed"] } } }),
  ]);
  const phase = nextProjectPhase({
    acceptedPlan: Boolean(acceptedPlan),
    unresolvedCapabilityGaps: gaps.length,
    readyTasks: tasks.filter((task) => task.status === "ready").length,
    activeTasks: tasks.filter((task) => ["claimed", "running"].includes(task.status)).length,
    reviewTasks: tasks.filter((task) => task.status === "in_review").length,
    qaTasks: tasks.filter((task) => task.outputContract === "qa_result" && task.status !== "completed").length,
    failedTasks: tasks.filter((task) => task.status === "failed").length,
    blockedTasks: tasks.filter((task) => task.status === "blocked").length,
    completedRequiredTasks: tasks.filter((task) => task.status === "completed").length,
    totalRequiredTasks: tasks.filter((task) => task.status !== "cancelled").length,
    completionEvidenceCount: tasks.filter((task) => task.nextStep?.includes("Evidence:")).length,
  });
  if (project.phase !== phase) {
    await prisma.project.update({ where: { id: projectId }, data: { phase, status: phase } });
  }
  return phase;
}

export async function resolvePlanCapabilities(params: {
  userId: string;
  projectId: string;
  planId: string;
}) {
  const plan = await prisma.projectPlan.findUniqueOrThrow({ where: { id: params.planId } });
  const body = parseJson<{ requiredCapabilities?: Array<{ name: string; type: "skill" | "tool" | "runtime" | "credential" | "agent" }> }>(plan.body, {});
  const resolutions = await resolveCapabilities(params.userId, body.requiredCapabilities ?? []);
  await prisma.projectPlan.update({
    where: { id: params.planId },
    data: { capabilityResolution: json({ resolvedAt: new Date().toISOString(), resolutions }) },
  }).catch(() => undefined);
  const gaps = [];
  for (const resolution of resolutions) {
    if (!["missing_skill", "missing_tool", "available_but_weak"].includes(resolution.state)) continue;
    const gap = await prisma.capabilityGap.create({
      data: {
        userId: params.userId,
        projectId: params.projectId,
        capabilityName: resolution.name,
        capabilityType: resolution.type,
        status: "detected",
        assignedAgent: "sophos",
        blockedReason: resolution.reason,
      },
    });
    gaps.push(gap);
    const task = await prisma.projectTask.create({
      data: {
        projectId: params.projectId,
        userId: params.userId,
        title: `Resolve capability: ${resolution.name}`,
        description: resolution.reason,
        status: "ready",
        assignedAgent: "sophos",
        responsibleAgent: "project-manager",
        acceptanceCriteria: "Capability gap is resolved, validated, and any executable skill is armed by approval.",
        outputContract: "capability_gap_resolution",
      },
    });
    await createWakeup({
      userId: params.userId,
      projectId: params.projectId,
      taskId: task.id,
      agentKey: "sophos",
      source: "skill-agency",
      reason: "capability_gap_detected",
      payload: { gapId: gap.id, capabilityName: gap.capabilityName },
      taskVersion: task.updatedAt ?? Date.now(),
    });
  }
  if (gaps.length) await prisma.project.update({ where: { id: params.projectId }, data: { phase: "capability_resolution", status: "capability_resolution" } });
  return { resolutions, gaps };
}
