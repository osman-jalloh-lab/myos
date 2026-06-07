import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUpcomingEvents } from "@/lib/calendar";

/**
 * GET /api/calendar?days=7
 * Returns upcoming events across all linked Google accounts.
 * Kairos uses this to build time blocks and detect conflicts.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const days = Math.min(Math.max(parseInt(searchParams.get("days") ?? "7"), 1), 30);

  const events = await getUpcomingEvents(session.user.id, days);
  return NextResponse.json({ events, count: events.length });
}
