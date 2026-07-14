import { prisma } from "@/lib/db";
import { getRegisteredSkills } from "@/lib/skills/registry";
import { listTaskArtifactContext, type TaskArtifactContext } from "./task-artifacts";

export type CompletedDependencyContext = {
  taskId: string;
  title: string;
  completedAt: string | null;
  evidenceSummary: string | null;
};

export type RuntimeSkillContext = {
  id: string;
  name: string;
  safetyClass: string;
  executionTool: string | null;
};

export type ProjectExecutionContext = {
  projectId: string;
  name: string;
  description: string | null;
  phase: string;
  status: string;
  latestInstruction: string | null;
  localFolderPath: string | null;
  workspace: { kind: "hermes_repo" | "project_folder" | "missing"; path: string | null; reason: string };
};

export type AgentExecutionInput = {
  userId: string;
  projectId: string;
  projectTaskId: string;
  planId: string | null;
  wakeupId: string;
  executionRunId: string;
  agentKey: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string[];
  outputContract: string | null;
  requiredCapabilities: string[];
  dependencies: CompletedDependencyContext[];
  projectContext: ProjectExecutionContext;
  approvedSkills: RuntimeSkillContext[];
  previousArtifacts: TaskArtifactContext[];
  correlationId: string;
};

function parseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => typeof item === "string" ? item : JSON.stringify(item));
  } catch {
    return value.split(/\n|;/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function criteriaFrom(value: string | null): string[] {
  if (!value) return [];
  return value.split(/\n|;/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

export function resolveTaskWorkspace(project: { projectName: string; description: string | null; latestInstruction: string | null; localFolderPath: string | null }) {
  if (project.localFolderPath) {
    return { kind: "project_folder" as const, path: project.localFolderPath, reason: "Project has an approved local folder path." };
  }
  const approvedCurrent = process.env.HERMES_PROJECT_WORKSPACE?.trim();
  if (approvedCurrent) {
    return { kind: "hermes_repo" as const, path: approvedCurrent, reason: "Workspace was explicitly approved by HERMES_PROJECT_WORKSPACE." };
  }
  const instruction = project.latestInstruction?.toLowerCase() ?? "";
  if (/\b(this repository|current repo|existing repository|hermes os|myos)\b/.test(instruction)) {
    return { kind: "hermes_repo" as const, path: process.cwd(), reason: "The accepted request explicitly targets the current Hermes OS repository." };
  }
  return { kind: "missing" as const, path: null, reason: "No approved workspace is attached to this project." };
}

export async function loadTaskExecutionContext(params: {
  userId: string;
  wakeupId: string;
  executionRunId: string;
}): Promise<AgentExecutionInput> {
  const wakeup = await prisma.agentWakeup.findFirstOrThrow({ where: { id: params.wakeupId, userId: params.userId } });
  if (!wakeup.projectId || !wakeup.projectTaskId) throw new Error("Wakeup is not linked to a project task.");
  const [project, task, plan, dependencies, allTasks, previousArtifacts, skills] = await Promise.all([
    prisma.project.findFirstOrThrow({ where: { id: wakeup.projectId, userId: params.userId } }),
    prisma.projectTask.findUniqueOrThrow({ where: { id: wakeup.projectTaskId } }),
    prisma.projectPlan.findFirst({ where: { projectId: wakeup.projectId, status: "accepted" }, orderBy: { revision: "desc" } }),
    prisma.projectTaskDependency.findMany({ where: { projectId: wakeup.projectId, taskId: wakeup.projectTaskId } }),
    prisma.projectTask.findMany({ where: { projectId: wakeup.projectId } }),
    listTaskArtifactContext(wakeup.projectId),
    getRegisteredSkills(params.userId).catch(() => []),
  ]);
  const taskById = new Map(allTasks.map((item) => [item.id, item]));
  const completedDependencies = dependencies.map((dependency) => taskById.get(dependency.blockingTaskId)).filter(Boolean).map((dependencyTask) => ({
    taskId: dependencyTask!.id,
    title: dependencyTask!.title,
    completedAt: dependencyTask!.completedAt?.toISOString() ?? null,
    evidenceSummary: dependencyTask!.nextStep ?? null,
  }));
  const approvedSkills = skills
    .filter((skill) => skill.enabled && (skill.ownerAgents.includes(wakeup.agentKey) || skill.ownerAgents.includes("hermes")))
    .slice(0, 10)
    .map((skill) => ({ id: skill.id, name: skill.name, safetyClass: skill.safetyClass, executionTool: skill.executionTool }));

  return {
    userId: params.userId,
    projectId: wakeup.projectId,
    projectTaskId: wakeup.projectTaskId,
    planId: plan?.id ?? null,
    wakeupId: wakeup.id,
    executionRunId: params.executionRunId,
    agentKey: wakeup.agentKey,
    title: task.title,
    description: task.description,
    acceptanceCriteria: criteriaFrom(task.acceptanceCriteria),
    outputContract: task.outputContract,
    requiredCapabilities: parseArray(task.requiredCapabilities),
    dependencies: completedDependencies,
    projectContext: {
      projectId: project.id,
      name: project.projectName,
      description: project.description,
      phase: project.phase ?? project.status,
      status: project.status,
      latestInstruction: project.latestInstruction,
      localFolderPath: project.localFolderPath,
      workspace: resolveTaskWorkspace(project),
    },
    approvedSkills,
    previousArtifacts,
    correlationId: `${wakeup.projectId}:${wakeup.projectTaskId}:${wakeup.id}`,
  };
}
