import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimQueuedTask,
  inspectEngineeringTask,
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

  const task = await claimQueuedTask(executorName, executorJobId);
  if (!task) {
    return NextResponse.json({ ok: true, message: "no queued engineering tasks found" });
  }

  try {
    const updatedTask = await inspectEngineeringTask(task.id);
    return NextResponse.json({ ok: true, task: updatedTask });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Executor failed unexpectedly", message: message.slice(0, 200), taskId: task.id },
      { status: 500 }
    );
  }
}
