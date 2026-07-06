import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { approveAndConsume, getPlan, createImproveTask } from "@/lib/improve";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { transcript?: string; source?: string; planId?: string; approvalId?: string } | null;
  const transcript = (body?.transcript ?? "").trim();
  const source = body?.source?.trim() || "voice";
  const planId = body?.planId?.trim();
  const approvalId = body?.approvalId?.trim();

  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const plan = await getPlan(planId);
  if (!plan || plan.userId !== session.user.id) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (plan.risk === "red") {
    return NextResponse.json({ error: "Manual review required", plan }, { status: 403 });
  }

  if (plan.risk !== "green" && !approvalId) {
    return NextResponse.json({ error: "approvalId is required for this risk class", planId: plan.id, requiresApproval: true }, { status: 403 });
  }

  if (approvalId) {
    try {
      await approveAndConsume(approvalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval rejected";
      const status = /expired|mismatch|wrong user|not found|not approvable/i.test(message) ? 409 : 403;
      return NextResponse.json({ error: message }, { status });
    }
  }

  const task = await createImproveTask({
    userId: session.user.id,
    planId: plan.id,
    approvalId,
    title: `Voice: ${transcript.slice(0, 80) || plan.capabilityName}`,
    description: transcript ? `Voice command transcript: ${transcript}` : `Capability request: ${plan.capabilityName}`,
    executor: plan.executor,
    executionProfile: plan.executionProfile,
    branch: `improve-${plan.normalizedIntent}-${Date.now()}`,
  });

  return NextResponse.json({
    ok: true,
    taskId: task.taskId,
    status: "queued",
    plan,
    message: `Intent: ${plan.normalizedIntent}`,
  });
}
