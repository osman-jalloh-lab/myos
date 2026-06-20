// AgentTask execution registry.
//
// Hard rule: Hermes may only assert "done", "completed", "build passed",
// "I patched it", "I ran it", or similar ONLY when an AgentTask row with
// status="completed" exists. Status questions query this table first —
// never the approval queue, never a vague LLM guess.

import { prisma } from "@/lib/db";

export type AgentTaskStatus = "queued" | "running" | "blocked" | "completed" | "failed";

export interface AgentTaskView {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: AgentTaskStatus;
  files: string[] | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: string;
  files: string | null;
  result: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentTaskView {
  let files: string[] | null = null;
  try {
    files = row.files ? (JSON.parse(row.files) as string[]) : null;
  } catch { /* malformed JSON — treat as null */ }
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status as AgentTaskStatus,
    files,
    result: row.result,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Create a task entry when Hermes begins a coding/build/execution task. */
export async function createAgentTask(
  userId: string,
  title: string,
  description: string,
  files?: string[]
): Promise<AgentTaskView> {
  const row = await prisma.agentTask.create({
    data: {
      userId,
      title: title.slice(0, 200),
      description: description.slice(0, 2000),
      status: "running",
      files: files ? JSON.stringify(files) : null,
    },
  });
  return toView(row);
}

/** Update task status after a real tool result arrives. */
export async function updateAgentTask(
  taskId: string,
  status: AgentTaskStatus,
  result?: string,
  error?: string
): Promise<AgentTaskView> {
  const row = await prisma.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      result: result ? result.slice(0, 2000) : undefined,
      error: error ? error.slice(0, 1000) : undefined,
    },
  });
  return toView(row);
}

/** All tasks that are not yet in a terminal state (queued or running). */
export async function getActiveAgentTasks(userId: string): Promise<AgentTaskView[]> {
  const rows = await prisma.agentTask.findMany({
    where: { userId, status: { in: ["queued", "running", "blocked"] } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(toView);
}

/** Most recent task regardless of status — used to answer "are you done?" */
export async function getLatestAgentTask(userId: string): Promise<AgentTaskView | null> {
  const row = await prisma.agentTask.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return row ? toView(row) : null;
}

/** Recent tasks (last N) for the context block in routeMessage. */
export async function getRecentAgentTasks(userId: string, limit = 5): Promise<AgentTaskView[]> {
  const rows = await prisma.agentTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toView);
}

// ── Status formatting ─────────────────────────────────────────────────────────
// Produces a grounded plain-text answer for status questions.
// Never says "clean", "no issues", or "done" without evidence.

export function formatAgentTaskStatusReply(
  latest: AgentTaskView | null,
  active: AgentTaskView[]
): string {
  if (!latest) {
    return "I don't have a task record for that yet, so I can't verify whether it ran.";
  }

  const lines: string[] = [];

  // Most recent task
  const age = Math.round((Date.now() - new Date(latest.updatedAt).getTime()) / 1000 / 60);
  const ageStr = age < 2 ? "just now" : age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;

  lines.push(`Last task: "${latest.title}" — ${latest.status.toUpperCase()} (${ageStr})`);

  if (latest.status === "completed" && latest.result) {
    lines.push(`Result: ${latest.result.slice(0, 200)}`);
  }
  if (latest.status === "failed" && latest.error) {
    lines.push(`Error: ${latest.error.slice(0, 200)}`);
  }
  if (latest.status === "running") {
    lines.push("Still running — no result yet.");
  }
  if (latest.status === "blocked") {
    lines.push("Blocked — waiting on something before it can proceed.");
  }

  // Any other active tasks
  const otherActive = active.filter((t) => t.id !== latest.id);
  if (otherActive.length > 0) {
    lines.push(`${otherActive.length} other active task${otherActive.length !== 1 ? "s" : ""}:`);
    for (const t of otherActive.slice(0, 3)) {
      lines.push(`  ${t.status.toUpperCase()} — ${t.title}`);
    }
  }

  return lines.join("\n");
}
