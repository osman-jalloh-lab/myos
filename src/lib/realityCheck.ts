// Reality Layer — prevents Hermes from making unverified claims.
//
// Rule: Hermes may only assert "done", "completed", "build passed",
// "I changed the file", "no blockers", or "task state is clean" when
// actual evidence exists from one of the listed sources.
//
// If no evidence exists, Hermes must say it.
// Approval queue status is NEVER a substitute for task status.

import { prisma } from "@/lib/db";

export type EvidenceSource =
  | "AgentTask"     // Task row in the DB
  | "AgentRun"      // AgentRun row (cron, execution, handoff)
  | "tool_result"   // explicit return value from a tool call
  | "build_output"  // typecheck / next build stdout
  | "db_query"      // arbitrary prisma query result
  | "approval_queue" // ApprovalAction row
  | "calendar_event" // Google Calendar API response
  | "email_response" // Gmail API response
  | "none";          // no evidence — will always resolve uncertain/blocked

export type EvidenceTag = "verified" | "inferred" | "uncertain" | "blocked";

export interface RealityCheckInput {
  claim: string;
  evidence: unknown | null | undefined;
  source: EvidenceSource;
}

export interface RealityCheckResult {
  status: EvidenceTag;
  safeClaim: string;
  missingEvidence?: string;
}

export function realityCheck(input: RealityCheckInput): RealityCheckResult {
  const { claim, evidence, source } = input;

  // No evidence at all — always uncertain
  if (source === "none" || evidence === null || evidence === undefined) {
    return {
      status: "uncertain",
      safeClaim: "I don't have evidence that this ran yet.",
      missingEvidence: `Need evidence from one of: AgentTask record, tool result, build output, or DB query. Got source="${source}".`,
    };
  }

  // Approval queue is explicitly forbidden as a proxy for task completion
  if (source === "approval_queue") {
    return {
      status: "blocked",
      safeClaim: "I can't verify task completion from approval queue status — those are separate records.",
      missingEvidence: "Task completion requires a Task row or AgentRun row, not an ApprovalAction.",
    };
  }

  // Evidence exists and source is trustworthy
  const trustedSources: EvidenceSource[] = [
    "AgentTask", "AgentRun", "tool_result", "build_output",
    "db_query", "calendar_event", "email_response",
  ];

  if (trustedSources.includes(source) && evidence) {
    // If evidence is an object with a status field, check it
    if (typeof evidence === "object" && evidence !== null) {
      const rec = evidence as Record<string, unknown>;
      const status = rec.status as string | undefined;

      if (status === "done" || status === "completed" || status === "executed") {
        return { status: "verified", safeClaim: claim };
      }
      if (status === "in_progress" || status === "running") {
        return {
          status: "inferred",
          safeClaim: `${claim} — currently in progress, not yet confirmed complete.`,
        };
      }
      if (status === "failed" || status === "blocked") {
        return {
          status: "verified",
          safeClaim: `Last recorded state is "${status}" — not completed successfully.`,
        };
      }
      // Evidence exists but status is unknown or absent
      return { status: "inferred", safeClaim: `${claim} (based on ${source} record — status not conclusive)` };
    }
    return { status: "verified", safeClaim: claim };
  }

  return {
    status: "uncertain",
    safeClaim: "I can't verify that from current task state.",
    missingEvidence: `Source "${source}" did not produce usable evidence.`,
  };
}

// ── TaskStateSnapshot ─────────────────────────────────────────────────────────
// Queries AgentRun + Task tables and returns a grounded status summary string
// for Hermes to embed in its reply. This is what "check task state" must call.

export interface TaskStateSnapshot {
  hasTasks: boolean;
  recentTasks: {
    id: string;
    title: string;
    status: string;
    assignedAgent: string | null;
    resolvedAt: string | null;
    createdAt: string;
  }[];
  recentRuns: {
    id: string;
    agentName: string;
    status: string;
    inputSummary: string | null;
    outputSummary: string | null;
    createdAt: string;
  }[];
  pendingCount: number;
  doneCount: number;
  failedCount: number;
}

export async function queryTaskState(userId: string, limit = 10): Promise<TaskStateSnapshot> {
  const [tasks, runs] = await Promise.all([
    prisma.task.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  const pendingCount = tasks.filter((t) => t.status === "open" || t.status === "in_progress").length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const failedCount = runs.filter((r) => r.status === "failed").length;

  return {
    hasTasks: tasks.length > 0,
    recentTasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignedAgent: t.assignedAgent,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
    recentRuns: runs.map((r) => ({
      id: r.id,
      agentName: r.agentName,
      status: r.status,
      inputSummary: r.inputSummary,
      outputSummary: r.outputSummary,
      createdAt: r.createdAt.toISOString(),
    })),
    pendingCount,
    doneCount,
    failedCount,
  };
}

// Formats a TaskStateSnapshot into a plain-text Hermes reply.
// Never says "clean" or "no issues" unless evidence actually supports it.
export function formatTaskStateReply(snapshot: TaskStateSnapshot): string {
  if (!snapshot.hasTasks && snapshot.recentRuns.length === 0) {
    return "I don't have a task record for this yet, so I can't verify whether it ran.";
  }

  const lines: string[] = [];

  if (snapshot.recentTasks.length > 0) {
    lines.push(`Task records (${snapshot.recentTasks.length} total):`);
    for (const t of snapshot.recentTasks.slice(0, 5)) {
      const agent = t.assignedAgent ? ` [${t.assignedAgent}]` : "";
      const resolved = t.resolvedAt ? ` — resolved ${t.resolvedAt.slice(0, 10)}` : "";
      lines.push(`  ${t.status.toUpperCase()} — ${t.title}${agent}${resolved}`);
    }
  }

  if (snapshot.recentRuns.length > 0) {
    lines.push(`Recent agent runs (${snapshot.recentRuns.length}):`);
    for (const r of snapshot.recentRuns.slice(0, 5)) {
      const summary = r.outputSummary ? ` — ${r.outputSummary.slice(0, 80)}` : "";
      lines.push(`  ${r.status.toUpperCase()} — ${r.agentName} (${r.createdAt.slice(0, 10)})${summary}`);
    }
  }

  const statusLine: string[] = [];
  if (snapshot.pendingCount > 0) statusLine.push(`${snapshot.pendingCount} pending`);
  if (snapshot.doneCount > 0) statusLine.push(`${snapshot.doneCount} done`);
  if (snapshot.failedCount > 0) statusLine.push(`${snapshot.failedCount} failed runs`);
  if (statusLine.length > 0) lines.push(`Summary: ${statusLine.join(", ")}.`);

  return lines.join("\n");
}
