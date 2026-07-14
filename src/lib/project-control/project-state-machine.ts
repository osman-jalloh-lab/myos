export type ProjectPhase =
  | "intake"
  | "council_review"
  | "awaiting_user_choice"
  | "planning"
  | "awaiting_plan_approval"
  | "capability_resolution"
  | "ready"
  | "executing"
  | "reviewing"
  | "qa"
  | "awaiting_deploy_approval"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type ProjectTaskStatus =
  | "backlog"
  | "ready"
  | "claimed"
  | "running"
  | "in_review"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ProjectStateSnapshot = {
  acceptedPlan: boolean;
  needsUserChoice?: boolean;
  unresolvedCapabilityGaps: number;
  readyTasks: number;
  activeTasks: number;
  reviewTasks: number;
  qaTasks: number;
  failedTasks: number;
  blockedTasks: number;
  completedRequiredTasks: number;
  totalRequiredTasks: number;
  deploymentApprovalRequired?: boolean;
  completionEvidenceCount: number;
  cancelled?: boolean;
};

export function nextProjectPhase(snapshot: ProjectStateSnapshot): ProjectPhase {
  if (snapshot.cancelled) return "cancelled";
  if (!snapshot.acceptedPlan) return snapshot.needsUserChoice ? "awaiting_user_choice" : "planning";
  if (snapshot.unresolvedCapabilityGaps > 0) return "capability_resolution";
  if (snapshot.failedTasks > 0) return "failed";
  if (snapshot.blockedTasks > 0 && snapshot.readyTasks === 0 && snapshot.activeTasks === 0) return "blocked";
  if (snapshot.readyTasks > 0) return "ready";
  if (snapshot.activeTasks > 0) return "executing";
  if (snapshot.reviewTasks > 0) return "reviewing";
  if (snapshot.qaTasks > 0) return "qa";
  if (snapshot.deploymentApprovalRequired) return "awaiting_deploy_approval";
  if (
    snapshot.totalRequiredTasks > 0 &&
    snapshot.completedRequiredTasks >= snapshot.totalRequiredTasks &&
    snapshot.completionEvidenceCount > 0
  ) {
    return "completed";
  }
  return "blocked";
}

export function taskBlockedByUnfinishedDependencies(
  dependencies: Array<{ taskId: string; blockingTaskId: string }>,
  tasks: Array<{ id: string; status: string }>
): Set<string> {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const blocked = new Set<string>();
  for (const dependency of dependencies) {
    if (statusById.get(dependency.blockingTaskId) !== "completed") blocked.add(dependency.taskId);
  }
  return blocked;
}

export function taskWakeupIdempotencyKey(params: {
  projectId: string;
  taskId: string;
  agentKey: string;
  reason: string;
  taskVersion: string | number | Date;
}): string {
  const version = params.taskVersion instanceof Date ? params.taskVersion.toISOString() : String(params.taskVersion);
  return `${params.projectId}:${params.taskId}:${params.agentKey}:${params.reason}:${version}`;
}
