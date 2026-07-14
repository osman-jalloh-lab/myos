import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

type FlowNode = {
  id: string;
  label: string;
  kind: "project" | "plan" | "task" | "agent" | "wakeup" | "capability_gap" | "approval" | "run" | "artifact";
  status?: string | null;
  agentKey?: string | null;
};

type FlowEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function safeJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(raw)) {
        if (/secret|token|key|password|auth/i.test(key)) continue;
        safe[key] = typeof item === "string" && item.length > 280 ? `${item.slice(0, 280)}...` : item;
      }
      return safe;
    }
    return parsed;
  } catch {
    return value.length > 280 ? `${value.slice(0, 280)}...` : value;
  }
}

function addNode(nodes: Map<string, FlowNode>, node: FlowNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function timelineEvent(kind: string, title: string, at: Date | string | null | undefined, details?: Record<string, unknown>) {
  return { kind, title, at: iso(at), details: details ?? {} };
}

type TimelineEvent = ReturnType<typeof timelineEvent>;

function isTimelineEvent(value: TimelineEvent | null): value is TimelineEvent {
  return value !== null;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "Missing projectId" }, { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: session.user.id },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const [plan, tasks, dependencies, wakeups, capabilityGaps, approvals, runs, taskArtifacts] = await Promise.all([
    prisma.projectPlan.findFirst({ where: { projectId }, orderBy: { revision: "desc" } }),
    prisma.projectTask.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { title: "asc" }] }),
    prisma.projectTaskDependency.findMany({ where: { projectId } }),
    prisma.agentWakeup.findMany({ where: { projectId }, orderBy: { requestedAt: "desc" }, take: 80 }),
    prisma.capabilityGap.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.approvalAction.findMany({
      where: { userId: session.user.id, payload: { contains: projectId } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.executionRun.findMany({ where: { projectId }, orderBy: { startedAt: "desc" }, take: 80 }),
    prisma.projectTaskArtifact.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 80 }),
  ]);

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  addNode(nodes, { id: `project:${project.id}`, label: project.projectName, kind: "project", status: project.phase ?? project.status });
  addNode(nodes, { id: "agent:project-manager", label: "Project Manager", kind: "agent", agentKey: "project-manager" });
  edges.push({ id: "project-manager-controls-project", from: "agent:project-manager", to: `project:${project.id}`, label: "controls" });

  if (plan) {
    addNode(nodes, { id: `plan:${plan.id}`, label: `Plan r${plan.revision}`, kind: "plan", status: plan.status });
    edges.push({ id: `project-plan-${plan.id}`, from: `project:${project.id}`, to: `plan:${plan.id}`, label: "latest plan" });
  }

  for (const task of tasks) {
    const taskId = `task:${task.id}`;
    addNode(nodes, { id: taskId, label: task.title, kind: "task", status: task.status, agentKey: task.assignedAgent });
    edges.push({ id: `project-task-${task.id}`, from: `project:${project.id}`, to: taskId, label: "owns" });
    if (task.assignedAgent) {
      const agentId = `agent:${task.assignedAgent}`;
      addNode(nodes, { id: agentId, label: task.assignedAgent, kind: "agent", agentKey: task.assignedAgent });
      edges.push({ id: `agent-task-${task.id}`, from: agentId, to: taskId, label: "assigned" });
    }
  }

  for (const dependency of dependencies) {
    edges.push({
      id: `dependency-${dependency.blockingTaskId}-${dependency.taskId}`,
      from: `task:${dependency.blockingTaskId}`,
      to: `task:${dependency.taskId}`,
      label: "blocks",
    });
  }

  for (const wakeup of wakeups) {
    const wakeupId = `wakeup:${wakeup.id}`;
    addNode(nodes, { id: wakeupId, label: wakeup.reason, kind: "wakeup", status: wakeup.status, agentKey: wakeup.agentKey });
    addNode(nodes, { id: `agent:${wakeup.agentKey}`, label: wakeup.agentKey, kind: "agent", agentKey: wakeup.agentKey });
    edges.push({ id: `wakeup-agent-${wakeup.id}`, from: wakeupId, to: `agent:${wakeup.agentKey}`, label: "wakes" });
    if (wakeup.projectTaskId) edges.push({ id: `wakeup-task-${wakeup.id}`, from: wakeupId, to: `task:${wakeup.projectTaskId}`, label: "for task" });
  }

  for (const gap of capabilityGaps) {
    const gapId = `gap:${gap.id}`;
    addNode(nodes, { id: gapId, label: gap.capabilityName, kind: "capability_gap", status: gap.status, agentKey: gap.assignedAgent });
    edges.push({ id: `project-gap-${gap.id}`, from: `project:${project.id}`, to: gapId, label: "capability gap" });
  }

  for (const approval of approvals) {
    const approvalId = `approval:${approval.id}`;
    addNode(nodes, { id: approvalId, label: approval.actionType, kind: "approval", status: approval.status });
    edges.push({ id: `project-approval-${approval.id}`, from: `project:${project.id}`, to: approvalId, label: "approval" });
  }

  for (const run of runs) {
    const runId = `run:${run.id}`;
    addNode(nodes, { id: runId, label: run.executor, kind: "run", status: run.status, agentKey: run.executor });
    if (run.taskId) edges.push({ id: `run-task-${run.id}`, from: `task:${run.taskId}`, to: runId, label: "claimed by" });
  }

  for (const artifact of taskArtifacts) {
    const artifactId = `artifact:${artifact.id}`;
    addNode(nodes, { id: artifactId, label: artifact.title, kind: "artifact", status: artifact.artifactType, agentKey: artifact.agentKey });
    edges.push({ id: `artifact-task-${artifact.id}`, from: `task:${artifact.projectTaskId}`, to: artifactId, label: "produced" });
  }

  const artifacts = [
    project.localFolderPath ? { id: "artifact:local-folder", kind: "local_folder", label: "Local project folder", uri: project.localFolderPath } : null,
    project.localDevUrl ? { id: "artifact:local-dev-url", kind: "local_dev_url", label: "Local preview", uri: project.localDevUrl } : null,
    project.localResearchBrief ? { id: "artifact:research-brief", kind: "research_artifact", label: "Research brief" } : null,
    project.localDesignReview ? { id: "artifact:design-review", kind: "review_artifact", label: "Design review" } : null,
    project.localQaChecklist ? { id: "artifact:qa-checklist", kind: "qa_result", label: "QA checklist" } : null,
    ...taskArtifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.artifactType,
      label: artifact.title,
      summary: artifact.summary,
      uri: artifact.safeLocation ?? undefined,
      taskId: artifact.projectTaskId,
      runId: artifact.executionRunId,
      createdAt: iso(artifact.createdAt),
    })),
  ].filter(Boolean);

  const timeline = [
    timelineEvent("project", "Project created", project.createdAt, { phase: project.phase ?? project.status }),
    plan ? timelineEvent("plan", `Plan r${plan.revision} ${plan.status}`, plan.createdAt, { acceptedAt: iso(plan.acceptedAt) }) : null,
    ...tasks.flatMap((task) => [
      timelineEvent("task", `Task: ${task.title}`, task.createdAt, { status: task.status, assignedAgent: task.assignedAgent }),
      task.completedAt ? timelineEvent("task_completed", `Completed: ${task.title}`, task.completedAt, { evidence: safeJson(task.nextStep) }) : null,
    ]),
    ...wakeups.map((wakeup) => timelineEvent("wakeup", `Wake ${wakeup.agentKey}: ${wakeup.reason}`, wakeup.requestedAt, { status: wakeup.status, coalescedCount: wakeup.coalescedCount })),
    ...capabilityGaps.map((gap) => timelineEvent("capability_gap", `Capability gap: ${gap.capabilityName}`, gap.createdAt, { status: gap.status, type: gap.capabilityType })),
    ...approvals.map((approval) => timelineEvent("approval", `Approval: ${approval.actionType}`, approval.createdAt, { status: approval.status })),
    ...runs.map((run) => timelineEvent("run", `Run: ${run.executor}`, run.startedAt, { status: run.status, phase: run.currentPhase })),
    ...taskArtifacts.map((artifact) => timelineEvent("artifact", `Artifact: ${artifact.title}`, artifact.createdAt, { type: artifact.artifactType, taskId: artifact.projectTaskId })),
  ].filter(isTimelineEvent).sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.projectName,
      description: project.description,
      status: project.status,
      phase: project.phase ?? project.status,
      assignedAgent: project.assignedAgent,
      latestPlanId: project.latestPlanId,
      completedAt: iso(project.completedAt),
      updatedAt: iso(project.updatedAt),
    },
    plan: plan ? {
      id: plan.id,
      revision: plan.revision,
      status: plan.status,
      createdByAgent: plan.createdByAgent,
      acceptedAt: iso(plan.acceptedAt),
      body: safeJson(plan.body),
      decisionSnapshot: safeJson(plan.decisionSnapshot),
    } : null,
    nodes: [...nodes.values()],
    edges,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      assignedAgent: task.assignedAgent,
      responsibleAgent: task.responsibleAgent,
      acceptanceCriteria: task.acceptanceCriteria,
      outputContract: task.outputContract,
      blockedReason: task.blockedReason,
      startedAt: iso(task.startedAt),
      completedAt: iso(task.completedAt),
      updatedAt: iso(task.updatedAt),
    })),
    wakeups: wakeups.map((wakeup) => ({
      id: wakeup.id,
      projectTaskId: wakeup.projectTaskId,
      agentKey: wakeup.agentKey,
      source: wakeup.source,
      reason: wakeup.reason,
      status: wakeup.status,
      coalescedCount: wakeup.coalescedCount,
      requestedAt: iso(wakeup.requestedAt),
      payload: safeJson(wakeup.payload),
    })),
    capabilityGaps: capabilityGaps.map((gap) => ({
      id: gap.id,
      projectTaskId: gap.projectTaskId,
      capabilityName: gap.capabilityName,
      capabilityType: gap.capabilityType,
      status: gap.status,
      assignedAgent: gap.assignedAgent,
      blockedReason: gap.blockedReason,
      createdAt: iso(gap.createdAt),
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      actionType: approval.actionType,
      status: approval.status,
      createdAt: iso(approval.createdAt),
      resolvedAt: iso(approval.resolvedAt),
    })),
    runs: runs.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      executor: run.executor,
      status: run.status,
      currentPhase: run.currentPhase,
      currentActivity: run.currentActivity,
      startedAt: iso(run.startedAt),
      completedAt: iso(run.completedAt),
    })),
    artifacts,
    timeline,
  });
}
