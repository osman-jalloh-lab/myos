// Approval queue — the gate every agent write passes through.
// Per CLAUDE.md rule 3 / master spec section 7: nothing writes silently.
// An ApprovalAction moves pending -> approved|rejected, and only an
// *approved* action may ever be executed against a real external system.
import { prisma } from "./db";

export type ApprovalActionType =
  | "draft_email"
  | "send_email"
  | "create_event"
  | "create_task"
  | "label_email"
  | "save_memory"
  | "delete_memory"
  | "apply_to_job"
  | "log_expense"
  | "log_income"
  | "add_job"
  | "update_job_status"
  | "engineering_plan"
  | "skill_scout_import";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed";

export interface ApprovalActionView {
  id: string;
  actionType: ApprovalActionType;
  payload: unknown;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  executionNote?: string;
}

function toView(row: {
  id: string;
  actionType: string;
  payload: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}): ApprovalActionView {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    actionType: row.actionType as ApprovalActionType,
    payload,
    status: row.status as ApprovalStatus,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export async function listApprovals(
  userId: string,
  status?: ApprovalStatus
): Promise<ApprovalActionView[]> {
  const rows = await prisma.approvalAction.findMany({
    where: { userId, ...(status && { status }) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView);
}

// Scopes Iris/Kairos hold today are read-only (calendar.readonly, gmail.readonly).
// Action types below require write scopes that were deliberately not requested
// in Phase 3 (see decisions_log "Phase 3 partial, by request"). Approving these
// queues Osman's intent; actually executing them waits on a future re-consent
// flow that adds gmail.compose/gmail.send/calendar write scopes.
const SCOPE_BLOCKED: Record<ApprovalActionType, string | null> = {
  draft_email: "Requires gmail.compose — not yet granted (read-only Gmail scope per Phase 3 decision).",
  send_email: "Requires gmail.send — not yet granted, and email sends should stay manual per master-spec section 7 ('never fully automate sending sensitive emails').",
  create_event: "Requires calendar write scope — not yet granted (calendar.readonly only).",
  create_task: null,
  label_email: "Requires gmail.modify — not yet granted (read-only Gmail scope per Phase 3 decision).",
  save_memory: null,
  delete_memory: null,
  apply_to_job: "Job applications must always stay manual per master-spec section 7 ('never fully automate job applications').",
  log_expense: null,
  log_income: null,
  add_job: null,
  update_job_status: null,
  engineering_plan: null,
  skill_scout_import: null,
};

async function writeAuditLog(
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  detail?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { userId, action, resourceType, resourceId, detail: detail?.slice(0, 500) } });
  } catch {
    // Audit log failures must never break the main flow
  }
}

export async function approveAction(userId: string, id: string): Promise<ApprovalActionView> {
  const row = await prisma.approvalAction.findFirstOrThrow({ where: { id, userId } });
  if (row.status !== "pending") throw new Error(`Action is already ${row.status}`);

  const updated = await prisma.approvalAction.update({
    where: { id },
    data: { status: "approved", resolvedAt: new Date() },
  });

  const result = await executeIfPossible(updated);
  await writeAuditLog(userId, "approved", "ApprovalAction", id, `${row.actionType} — ${result.executionNote ?? "approved"}`);
  return result;
}

export async function rejectAction(userId: string, id: string): Promise<ApprovalActionView> {
  const row = await prisma.approvalAction.findFirstOrThrow({ where: { id, userId } });
  if (row.status !== "pending") throw new Error(`Action is already ${row.status}`);

  const updated = await prisma.approvalAction.update({
    where: { id },
    data: { status: "rejected", resolvedAt: new Date() },
  });
  await writeAuditLog(userId, "rejected", "ApprovalAction", id, `${row.actionType}`);
  return toView(updated);
}

function buildExecutionNote(actionType: ApprovalActionType, payloadJson: string): string {
  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    if (actionType === "log_expense") return `Logged $${(p.amountUsd as number).toFixed(2)} expense${p.description ? ` — ${p.description}` : ""}.`;
    if (actionType === "log_income") return `Logged $${(p.amountUsd as number).toFixed(2)} income${p.description ? ` — ${p.description}` : ""}.`;
    if (actionType === "add_job") return `Tracking ${p.title} at ${p.company}.`;
    if (actionType === "update_job_status") return `Job status updated to ${p.status}.`;
    if (actionType === "save_memory") return `Remembered: "${String(p.fact).slice(0, 80)}".`;
    if (actionType === "create_task") return `Task created: "${String(p.title).slice(0, 80)}".`;
    if (actionType === "delete_memory") return "Memory deleted.";
    if (actionType === "engineering_plan") return `Plan approved. Phase 1 (repo inspection) is queued — the executor will run on the next cron cycle. Ask "what's the status" any time.`;
  } catch { /* fall through */ }
  return "Approved and executed.";
}

// Executes an approved action if Hermes currently holds the scopes/tools to do
// so safely. Most write actions are blocked today by design (see SCOPE_BLOCKED) —
// they stay "approved" (Osman's intent is logged) until the underlying capability
// exists, at which point a future pass can pick up approved-but-unexecuted rows.
async function executeIfPossible(row: {
  id: string;
  userId: string;
  actionType: string;
  payload: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}): Promise<ApprovalActionView> {
  const actionType = row.actionType as ApprovalActionType;
  const blockedReason = SCOPE_BLOCKED[actionType];

  if (blockedReason) {
    const view = toView(row);
    view.executionNote = `Approved — execution held: ${blockedReason}`;
    return view;
  }

  let executionNote: string | null = null;

  // create_task / save_memory only ever touch our own DB — safe to execute
  // immediately once approved, since they hold no external write power.
  if (actionType === "create_task") {
    const payload = JSON.parse(row.payload) as {
      title: string;
      description?: string;
      dueAt?: string;
      source?: string;
      sourceRef?: string;
      priority?: string;
      assignedAgent?: string | null;
      delegatedBy?: string | null;
    };
    await prisma.task.create({
      data: {
        userId: row.userId,
        title: payload.title,
        description: payload.description,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
        source: payload.source,
        sourceRef: payload.sourceRef,
        priority: payload.priority ?? "medium",
        assignedAgent: payload.assignedAgent ?? null,
        delegatedBy: payload.delegatedBy ?? null,
      },
    });
  }

  if (actionType === "save_memory") {
    const payload = JSON.parse(row.payload) as { fact: string; source?: string };
    await prisma.memory.create({
      data: {
        userId: row.userId,
        fact: payload.fact,
        source: payload.source,
        approvedAt: new Date(),
      },
    });
  }

  if (actionType === "delete_memory") {
    const payload = JSON.parse(row.payload) as { memoryId: string };
    await prisma.memory.deleteMany({ where: { id: payload.memoryId, userId: row.userId } });
  }

  if (actionType === "log_expense" || actionType === "log_income") {
    const payload = JSON.parse(row.payload) as { kind: string; amountUsd: number; description?: string; category?: string };
    await prisma.financeEntry.create({
      data: {
        userId: row.userId,
        kind: payload.kind,
        amountUsd: payload.amountUsd,
        description: payload.description,
        category: payload.category,
      },
    });
  }

  if (actionType === "add_job") {
    const payload = JSON.parse(row.payload) as { title: string; company: string; url?: string; status?: string };
    await prisma.jobListing.create({
      data: {
        userId: row.userId,
        title: payload.title,
        company: payload.company,
        url: payload.url,
        source: "telegram",
        status: payload.status ?? "interested",
      },
    });
  }

  if (actionType === "update_job_status") {
    const payload = JSON.parse(row.payload) as { jobListingId: string; status: string };
    await prisma.jobListing.updateMany({
      where: { id: payload.jobListingId, userId: row.userId },
      data: { status: payload.status },
    });
  }

  if (actionType === "engineering_plan") {
    const payload = JSON.parse(row.payload) as {
      projectName: string;
      projectId: string | null;
      route?: string;
      steps?: string[];
      repositorySlug?: string;
    };

    // Phase 1: queue the repo inspection task
    const { createEngineeringTask } = await import("@/lib/engineeringTasks");
    await createEngineeringTask({
      userId: row.userId,
      title: `Build: ${payload.projectName}`,
      repositorySlug: payload.repositorySlug ?? "osman-jalloh-lab/parawi",
      operationType: "read_only_repo_inspection",
      riskLevel: "low",
      approvalRequired: false,
    });

    if (payload.projectId) {
      const { updateProjectStatus, getProjectTasks, createProjectTasksFromPlan } = await import("@/lib/memory-context");

      // Safety net: if tasks were never created (e.g. user found a non-standard
      // path to approval), create them now from the stored plan steps.
      if (payload.steps?.length) {
        const existing = await getProjectTasks(payload.projectId).catch(() => []);
        if (existing.length === 0) {
          const planSteps = payload.steps.map((title) => ({ title, assignedAgent: "prometheus" }));
          await createProjectTasksFromPlan(payload.projectId, row.userId, planSteps).catch(() => {});
        }
      }

      // Approval = active. "building" is for mid-execution — "active" means
      // the plan is approved and work is underway (or queued to start).
      await updateProjectStatus(payload.projectId, "active").catch(() => {});
    }
  }

  if (actionType === "skill_scout_import") {
    const payload = JSON.parse(row.payload) as { riskLevel?: string; candidateName?: string };
    if (String(payload.riskLevel ?? "").toLowerCase() !== "low") {
      const view = toView(row);
      view.executionNote = `Approved - execution held: ${String(payload.candidateName ?? "candidate")} is not low risk. Build a manual importer plan before writing files.`;
      return view;
    }

    const { importApprovedSkillScoutItem } = await import("@/lib/skill-scout/importer");
    const imported = await importApprovedSkillScoutItem(payload, row.userId);
    executionNote = imported.summary;
  }

  const executed = await prisma.approvalAction.update({
    where: { id: row.id },
    data: { status: "executed" },
  });
  const view = toView(executed);
  view.executionNote = executionNote ?? buildExecutionNote(actionType, row.payload);
  return view;
}

export async function createApproval(
  userId: string,
  actionType: ApprovalActionType,
  payload: unknown
): Promise<ApprovalActionView> {
  const payloadJson = JSON.stringify(payload);

  // Dedupe: an identical action already sitting in the queue means Osman has
  // seen this and not acted yet. Re-queueing it would just multiply the same
  // card every cron run / chat sync until he approves something he may never
  // want (the "same approval for days" bug). Return the existing row instead.
  const existing = await prisma.approvalAction.findFirst({
    where: { userId, actionType, payload: payloadJson, status: "pending" },
  });
  if (existing) return toView(existing);

  const row = await prisma.approvalAction.create({
    data: { userId, actionType, payload: payloadJson },
  });
  return toView(row);
}

export async function getLatestPendingApproval(userId: string): Promise<ApprovalActionView | null> {
  const row = await prisma.approvalAction.findFirst({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return row ? toView(row) : null;
}

export async function approvalCounts(userId: string): Promise<Record<ApprovalStatus, number>> {
  const rows = await prisma.approvalAction.groupBy({
    by: ["status"],
    where: { userId },
    _count: { status: true },
  });
  const counts: Record<ApprovalStatus, number> = { pending: 0, approved: 0, rejected: 0, executed: 0 };
  for (const r of rows) counts[r.status as ApprovalStatus] = r._count.status;
  return counts;
}
