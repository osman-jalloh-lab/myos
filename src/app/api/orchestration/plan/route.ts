import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createPlanPreview, type PlanningRequest } from "@/lib/orchestration/chat-planner";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as PlanningRequest | null;
  if (!body || typeof body.message !== "string") return NextResponse.json({ error: "message is required" }, { status: 400 });
  if (body.dataClass === ("SECRET" as never)) return NextResponse.json({ error: "SECRET dataClass is not accepted" }, { status: 400 });
  const preview = await createPlanPreview(session.user.id, body);
  return NextResponse.json(preview, { status: preview.accepted ? 200 : 400 });
}
