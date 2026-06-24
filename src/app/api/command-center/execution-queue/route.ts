import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listExecutionQueue } from "@/lib/execution-queue";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tasks = await listExecutionQueue(session.user.id, 60);
  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {
    queued: 0,
    planning: 0,
    executing: 0,
    qa_pending: 0,
    qa_passed: 0,
    waiting_approval: 0,
    completed: 0,
    failed: 0,
  });

  const executorHealth = Object.values(tasks.reduce<Record<string, {
    executor: string;
    active: number;
    failed: number;
    completed: number;
    lastUpdated: string;
  }>>((acc, task) => {
    const key = task.assignedExecutor || "hermes";
    const existing = acc[key] ?? {
      executor: key,
      active: 0,
      failed: 0,
      completed: 0,
      lastUpdated: task.updatedAt,
    };
    if (["queued", "planning", "executing", "qa_pending", "waiting_approval"].includes(task.status)) existing.active++;
    if (task.status === "failed") existing.failed++;
    if (task.status === "completed") existing.completed++;
    if (new Date(task.updatedAt).getTime() > new Date(existing.lastUpdated).getTime()) existing.lastUpdated = task.updatedAt;
    acc[key] = existing;
    return acc;
  }, {}));

  return NextResponse.json({
    tasks,
    counts,
    executorHealth,
    lastUpdated: new Date().toISOString(),
  });
}
