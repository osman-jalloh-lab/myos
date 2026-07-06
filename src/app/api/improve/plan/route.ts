import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createPlan, getPlan } from "@/lib/improve";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { requestText?: string; source?: string } | null;
  const requestText = (body?.requestText ?? "").trim();
  if (!requestText) {
    return NextResponse.json({ error: "requestText is required" }, { status: 400 });
  }

  const plan = await createPlan({
    userId: session.user.id,
    requestText,
    ttlMs: 60 * 60 * 1000,
  });

  return NextResponse.json({
    ok: true,
    planId: plan.id,
    ...plan,
  });
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const planId = url.searchParams.get("planId");
  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const plan = await getPlan(planId);
  if (!plan || plan.userId !== session.user.id) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, plan });
}
