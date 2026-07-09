import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listExecutionRuns } from "@/lib/execution-runs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const runs = await listExecutionRuns(session.user.id, 40);
  return NextResponse.json({ runs, lastUpdated: new Date().toISOString() });
}
