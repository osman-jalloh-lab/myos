import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { approveAndConsume, getPlan, createImproveTask } from "@/lib/improve";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { planId?: string; approvalId?: string } | null;
  const planId = body?.planId?.trim();
  const approvalId = body?.approvalId?.trim();

  if (!planId || !approvalId) {
    return NextResponse.json({ error: "planId and approvalId are required" }, { status: 400 });
  }

  try {
    const { approval, plan } = await approveAndConsume(approvalId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution rejected";
    const status = /expired|mismatch|wrong user|not found|not approvable/i.test(message) ? 409 : 403;
    return NextResponse.json({ error: message }, { status });
  }

  const planAfter = await getPlan(planId);
  if (!planAfter) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (planAfter.risk === "red") {
    return NextResponse.json({ error: "Manual review required", plan: planAfter }, { status: 403 });
  }

  try {
    const task = await createImproveTask({
      userId: session.user.id,
      planId: planAfter.id,
      approvalId,
      title: `Improve: ${planAfter.capabilityName}`,
      description: `Request: ${planAfter.requestText}`,
      executor: planAfter.executor,
      executionProfile: planAfter.executionProfile,
      branch: `improve-${planAfter.normalizedIntent}-${Date.now()}`,
    });

    return NextResponse.json({
      ok: true,
      plan: planAfter,
      taskId: task.taskId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task creation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
