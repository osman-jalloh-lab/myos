import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimQueuedTask,
  claimApprovedCodeChangeTask,
  inspectEngineeringTask,
  implementCodeChangeTask,
  type EngineeringTaskView,
} from "@/lib/engineeringTasks";

export const runtime = "nodejs";

const SECRET_HEADER = "authorization";
const SECRET_PREFIX = "Bearer ";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get(SECRET_HEADER) ?? "";

  if (!secret) {
    console.error(JSON.stringify({
      event: "engineering-executor.auth",
      result: "missing-secret",
    }));
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (auth !== `${SECRET_PREFIX}${secret}`) {
    console.error(JSON.stringify({
      event: "engineering-executor.auth",
      result: "invalid-token",
      authPresent: Boolean(auth),
    }));
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const executorName = "engineering-executor";
  const executorJobId = crypto.randomUUID();

  console.log(JSON.stringify({
    event: "engineering-executor.start",
    executorName,
    executorJobId,
  }));

  // Try Phase 1 (read-only inspection) first
  let task: EngineeringTaskView | null = await claimQueuedTask(executorName, executorJobId);
  let taskType: "inspection" | "code_change" = "inspection";

  // If no inspection task, try Phase 2 (approved code change)
  if (!task) {
    task = await claimApprovedCodeChangeTask(executorName, executorJobId);
    taskType = "code_change";
  }

  if (!task) {
    return NextResponse.json({ ok: true, message: "no queued engineering tasks found" });
  }

  console.log(JSON.stringify({
    event: "engineering-executor.dispatching",
    taskId: task.id,
    taskType,
    operationType: task.operationType,
    executorJobId,
  }));

  try {
    let updatedTask: EngineeringTaskView;

    if (taskType === "inspection") {
      updatedTask = await inspectEngineeringTask(task.id);
    } else {
      updatedTask = await implementCodeChangeTask(task.id, executorJobId);
    }

    return NextResponse.json({ ok: true, task: updatedTask });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: "engineering-executor.error",
      taskId: task.id,
      taskType,
      error: message.slice(0, 300),
      executorJobId,
    }));
    return NextResponse.json(
      {
        error: "Executor failed unexpectedly",
        message: message.slice(0, 200),
        taskId: task.id,
        taskType,
      },
      { status: 500 }
    );
  }
}
