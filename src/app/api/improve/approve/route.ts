import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createApproval, approveAndConsume, getPlan } from "@/lib/improve";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { planId?: string; approvalId?: string } | null;
  const planId = body?.planId?.trim();
  const approvalId = body?.approvalId?.trim();

  if (approvalId) {
    try {
      const { approval, plan } = await approveAndConsume(approvalId);
      return NextResponse.json({
        ok: true,
        approval,
        plan,
        task: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval failed";
      const status = /expired|mismatch|wrong user|not found|not approvable/i.test(message) ? 409 : 403;
      return NextResponse.json({ error: message }, { status });
    }
  }

  if (!planId) {
    return NextResponse.json({ error: "planId or approvalId is required" }, { status: 400 });
  }

  try {
    const approval = await createApproval({ planId, userId: session.user.id });
    return NextResponse.json({ ok: true, approval });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval creation failed";
    const status = /expired|not approvable|not found/i.test(message) ? 409 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
