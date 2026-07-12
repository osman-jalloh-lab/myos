import { prisma } from "@/lib/db";
import { answerCapabilityQuestion } from "@/lib/hermes-execution/capabilities";
import {
  acceptProjectPlan,
  createProposedProjectPlan,
  decomposeAcceptedPlan,
  resolvePlanCapabilities,
  startProjectFromDecision,
} from "./project-manager";
import { createDeterministicProjectPlan, type CouncilDecision } from "./project-planner";
import { classifyWorkRequest, type WorkRequestClassification } from "./request-classifier";
import { dispatchQueuedWakeups } from "./wakeup-dispatcher";

export type ProjectChatQuickAction = {
  id: string;
  label: string;
  value: string;
  description?: string;
};

export type ProjectChatWorkflowResult = {
  handled: boolean;
  answer?: string;
  quickActions?: ProjectChatQuickAction[];
  classification: WorkRequestClassification;
  projectId?: string;
  planId?: string;
};

function actionValue(action: string, projectId: string, planId?: string): string {
  return `project-control:${action}:${projectId}${planId ? `:${planId}` : ""}`;
}

function planQuickActions(projectId: string, planId: string): ProjectChatQuickAction[] {
  return [
    { id: "approve-plan", label: "Approve plan", value: actionValue("approve-plan", projectId, planId), description: "Accept this exact plan revision and queue ready work." },
    { id: "review-flow", label: "Review project flow", value: `View project flow for project ${projectId}`, description: "Open the Command Center Projects tab to inspect the graph." },
    { id: "change-scope", label: "Change scope", value: `Change scope for project ${projectId}: `, description: "Revise the plan before work is decomposed." },
    { id: "cancel-project", label: "Cancel project", value: actionValue("cancel", projectId, planId), description: "Cancel this proposed project." },
  ];
}

function formatCapabilityList(requirements: Array<{ name: string; type: string }>): string {
  if (!requirements.length) return "standard Hermes project planning";
  return requirements.map((item) => `${item.name} (${item.type})`).join(", ");
}

async function latestActiveProject(userId: string) {
  return prisma.project.findFirst({
    where: {
      userId,
      phase: { in: ["awaiting_plan_approval", "awaiting_user_choice", "capability_resolution", "ready", "executing", "reviewing", "qa", "blocked"] },
    },
    orderBy: { updatedAt: "desc" },
  });
}

function parseControlAction(message: string): { action: string; projectId: string; planId?: string } | null {
  const match = message.trim().match(/^project-control:([a-z-]+):([^:\s]+)(?::([^:\s]+))?/i);
  if (!match) return null;
  return { action: match[1], projectId: match[2], planId: match[3] };
}

function syntheticCouncilDecision(request: string): CouncilDecision {
  const proposed = createDeterministicProjectPlan(request);
  return {
    id: `council-${proposed.requestFingerprint.slice(0, 16)}`,
    title: proposed.title,
    summary: proposed.summary,
    selectedDirection: "Use the smallest durable project architecture that can satisfy the request safely.",
    rationale: "The request is large or high-risk enough to require one executive direction before implementation.",
    requirements: proposed.requiredCapabilities.map((capability) => capability.name),
    outOfScope: ["Unapproved deployment", "Secret handling changes without setup review"],
    deliverables: proposed.tasks.map((task) => task.title),
    requiredCapabilities: proposed.requiredCapabilities,
    recommendedAgents: ["project-manager", "athena", "prometheus", "argus"],
    risks: ["Scope expansion", "Validation failure", "Missing runtime or credential"],
    needsUserChoice: false,
    options: [],
    reviewerNotes: [{ reviewer: "council-chair", position: "Proceed with PM-controlled plan before implementation." }],
    revision: 1,
  };
}

export async function handleProjectControlChat(input: {
  userId: string;
  message: string;
  targetAgent?: string | null;
}): Promise<ProjectChatWorkflowResult> {
  const controlAction = parseControlAction(input.message);
  if (controlAction?.action === "approve-plan" && controlAction.planId) {
    const accepted = await acceptProjectPlan({ userId: input.userId, projectId: controlAction.projectId, planId: controlAction.planId });
    const capabilityResult = await resolvePlanCapabilities({ userId: input.userId, projectId: controlAction.projectId, planId: accepted.id });
    const setupBlockers = capabilityResult.resolutions.filter((resolution) => ["missing_runtime", "missing_credential"].includes(resolution.state));
    for (const blocker of setupBlockers) {
      await prisma.projectTask.create({
        data: {
          projectId: controlAction.projectId,
          userId: input.userId,
          title: `Setup blocker: ${blocker.name}`,
          description: blocker.reason,
          status: "blocked",
          assignedAgent: "project-manager",
          responsibleAgent: "project-manager",
          blockedReason: blocker.reason,
          requiredCapabilities: JSON.stringify([blocker]),
          outputContract: "setup_blocker",
        },
      });
    }
    await decomposeAcceptedPlan({ userId: input.userId, projectId: controlAction.projectId, planId: accepted.id });
    const dispatched = await dispatchQueuedWakeups({ userId: input.userId, projectId: controlAction.projectId, limit: 4 });
    const blockedLine = setupBlockers.length
      ? ` ${setupBlockers.length} setup blocker${setupBlockers.length === 1 ? "" : "s"} were recorded for runtime or credential work.`
      : "";
    return {
      handled: true,
      classification: { class: "project", confidence: 1, reason: "Accepted exact plan quick action.", isNewProject: false, isExistingProjectChange: true, requiresCouncil: false, estimatedScope: "medium", detectedProjectId: controlAction.projectId },
      projectId: controlAction.projectId,
      planId: accepted.id,
      answer: `Approved. I accepted plan revision ${accepted.revision}, decomposed it once, assigned dependency-ready tasks, and queued agent wakeups.${blockedLine} Project ${controlAction.projectId} is now visible in Project Flow.`,
      quickActions: [
        { id: "review-flow", label: "Review project flow", value: `View project flow for project ${controlAction.projectId}` },
        { id: "dispatch-wakeups", label: "Dispatch wakeups", value: `project-control:dispatch:${controlAction.projectId}:${accepted.id}`, description: `${dispatched.claimed.length} wakeup(s) claimed in this pass.` },
      ],
    };
  }
  if (controlAction?.action === "dispatch") {
    const dispatched = await dispatchQueuedWakeups({ userId: input.userId, projectId: controlAction.projectId, limit: 6 });
    const completed = await prisma.project.findFirst({ where: { id: controlAction.projectId, userId: input.userId, status: "completed" } });
    const completionArtifacts = completed ? await prisma.projectTaskArtifact.findMany({
      where: { projectId: completed.id, artifactType: "completion_report" },
      orderBy: { createdAt: "asc" },
    }) : [];
    return {
      handled: true,
      classification: { class: "small_action", confidence: 1, reason: "Manual wakeup dispatch quick action.", isNewProject: false, isExistingProjectChange: true, requiresCouncil: false, estimatedScope: "small", detectedProjectId: controlAction.projectId },
      projectId: controlAction.projectId,
      planId: controlAction.planId,
      answer: completed
        ? `Project ${completed.id} is completed. Hermes verified the accepted plan through implementation, design review, and Argus validation. Completion timestamp: ${completed.completedAt?.toISOString() ?? "recorded"}. Completion report artifacts: ${completionArtifacts.map((artifact) => artifact.id).join(", ") || "none"}. No commit, push, deploy, message send, or production-data access was performed.`
        : `Wakeup dispatch checked ${dispatched.checked} queued item(s), claimed ${dispatched.claimed.length}, and skipped ${dispatched.skipped.length}.`,
    };
  }
  if (controlAction?.action === "cancel") {
    await prisma.project.update({ where: { id: controlAction.projectId }, data: { phase: "cancelled", status: "cancelled" } }).catch(() => null);
    return {
      handled: true,
      classification: { class: "small_action", confidence: 1, reason: "Cancel project quick action.", isNewProject: false, isExistingProjectChange: true, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId: controlAction.projectId },
      projectId: controlAction.projectId,
      planId: controlAction.planId,
      answer: `Cancelled project ${controlAction.projectId}. No plan decomposition or agent wakeups will run for it.`,
    };
  }

  const active = await latestActiveProject(input.userId).catch(() => null);
  const classification = await classifyWorkRequest({
    message: input.message,
    targetAgent: input.targetAgent,
    conversationContext: { activeProjectId: active?.id ?? null, latestPlanId: active?.latestPlanId ?? null },
  });

  if (classification.class === "capability_question") {
    const snapshot = await import("@/lib/hermes-execution/capabilities").then((mod) => mod.getCapabilitySnapshot()).catch(() => null);
    return {
      handled: true,
      classification,
      answer: snapshot
        ? answerCapabilityQuestion(input.message, snapshot).answer
        : "I could not load the capability snapshot safely, so I am not going to guess. Check Health Center for worker/runtime status.",
    };
  }
  if (!["project", "council_project"].includes(classification.class)) {
    return { handled: false, classification };
  }

  const created = classification.class === "council_project"
    ? await startProjectFromDecision({ userId: input.userId, request: input.message, decision: syntheticCouncilDecision(input.message) })
    : await createProposedProjectPlan({ userId: input.userId, request: input.message });
  const planBody = JSON.parse(created.plan.body) as { requiredCapabilities?: Array<{ name: string; type: string }>; tasks?: Array<{ title: string }> };
  await prisma.projectPlan.update({
    where: { id: created.plan.id },
    data: { capabilityResolution: JSON.stringify({ status: "pending", requiredCapabilities: planBody.requiredCapabilities ?? [] }) },
  }).catch(() => null);

  return {
    handled: true,
    classification,
    projectId: created.project.id,
    planId: created.plan.id,
    answer: `Got it. I am treating this as a new project rather than a one-off code change. I created a proposed plan for ${created.project.projectName} and identified the first build phases. Nothing has been implemented yet.\n\nProject: ${created.project.id}\nPlan revision: ${created.plan.revision}\nRequired capabilities: ${formatCapabilityList(planBody.requiredCapabilities ?? [])}\nProposed phases: ${(planBody.tasks ?? []).map((task) => task.title).join(" -> ")}`,
    quickActions: planQuickActions(created.project.id, created.plan.id),
  };
}
