import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listExecutionEvents } from "@/lib/execution-runs";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const events = await listExecutionEvents(session.user.id, runId, 160);
  if (!events) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json({ events });
}
