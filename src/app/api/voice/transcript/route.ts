import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createPlan, getPlan } from "@/lib/improve";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { transcript?: string; source?: string } | null;
  const transcript = (body?.transcript ?? "").trim();
  const source = body?.source?.trim() || "voice";
  if (!transcript) {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  const plan = await createPlan({ userId: session.user.id, requestText: transcript, ttlMs: 60 * 60 * 1000 });

  return NextResponse.json({
    ok: true,
    source,
    planId: plan.id,
    transcript,
    preview: {
      action: plan.normalizedIntent,
      risk: plan.risk,
      summary: plan.summary,
    },
    requiresApproval: plan.requiresApproval,
  });
}
