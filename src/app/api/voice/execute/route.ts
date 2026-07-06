import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createExecutionQueueTask } from "@/lib/execution-queue";
import { handleBuildIntake } from "@/lib/build-intake";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { transcript?: string; source?: string } | null;
  const transcript = (body?.transcript ?? "").trim();
  const source = body?.source?.trim() || "voice";
  if (!transcript) {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  try {
    const contextChatId = `dashboard:shared:${session.user.id}`;
    const intake = await handleBuildIntake(contextChatId, session.user.id, transcript).catch(() => ({ action: "none" as const, message: transcript }));

    const task = await createExecutionQueueTask({
      userId: session.user.id,
      title: `Voice: ${transcript.slice(0, 80)}`,
      description: `Voice command transcript: ${transcript}`,
      priority: "medium",
      assignedExecutor: "hermes",
      initialLog: `source=${source} action=${intake.action}`,
    });

    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: task.status,
      message: intake.action === "none" ? task.title : `Intent: ${intake.action}`,
    });
  } catch (error) {
    console.error("[/api/voice/execute] failed", error);
    return NextResponse.json({ error: "Voice execution failed." }, { status: 500 });
  }
}
