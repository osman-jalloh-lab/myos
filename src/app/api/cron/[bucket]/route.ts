import { NextRequest, NextResponse } from "next/server";
import { runDueTasks, type Cadence } from "@/lib/agents/dispatcher";

export const maxDuration = 60;

const VALID_BUCKETS: Cadence[] = ["daily_am", "daily_pm", "weekly", "monthly"];

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ bucket: string }> }
) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { bucket } = await ctx.params;
  if (!VALID_BUCKETS.includes(bucket as Cadence)) {
    return NextResponse.json({ error: `unknown bucket: ${bucket}` }, { status: 400 });
  }

  const results = await runDueTasks(bucket as Cadence);
  const failed = results.filter((r) => !r.ok);

  return NextResponse.json({
    bucket,
    ran: results.length,
    failed: failed.length,
    results,
  });
}
