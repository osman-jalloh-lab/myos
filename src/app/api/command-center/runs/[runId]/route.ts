import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getExecutionRun } from "@/lib/execution-runs";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await getExecutionRun(session.user.id, runId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json({ run });
}
