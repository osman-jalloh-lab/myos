import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { triageInbox } from "@/agents/iris";

/**
 * GET /api/email?max=15
 * Returns inbox messages across all linked Google accounts, grouped by
 * Iris's heuristic categories (action_needed, personal, newsletter, ...).
 * Metadata-only — no message bodies are fetched.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const maxPerAccount = Math.min(Math.max(parseInt(searchParams.get("max") ?? "15"), 1), 50);

  const result = await triageInbox(session.user.id, maxPerAccount);
  return NextResponse.json(result);
}
