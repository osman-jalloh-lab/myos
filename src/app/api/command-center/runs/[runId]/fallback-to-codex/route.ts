import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requestCodexFallback } from "@/lib/execution-runs";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const body = (await req.json().catch(() => null)) as { confirmation?: string } | null;
  try {
    const run = await requestCodexFallback(session.user.id, runId, body?.confirmation ?? null);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Explicit confirmation is required." },
      { status: 400 },
    );
  }
}
