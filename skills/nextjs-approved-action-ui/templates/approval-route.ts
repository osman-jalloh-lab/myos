import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createApproval, approveAndConsume, getPlan } from "@/lib/<feature>";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await request.json().catch(() => ({ planId: "", approvalId: "" }));
  const { planId, approvalId } = json as { planId?: string; approvalId?: string };

  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const plan = await getPlan(planId, session.user.id);
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  // approval is required for non-read plans
  if (plan.requiresApproval) {
    if (!approvalId) {
      return NextResponse.json({ error: "approvalId is required" }, { status: 403 });
    }
    const ok = await approveAndConsume(planId, approvalId);
    if (!ok) return NextResponse.json({ error: "Approval invalid or expired" }, { status: 403 });
  }

  // create task via execution queue...
  return NextResponse.json({ taskId: "stub", status: "queued" });
}
