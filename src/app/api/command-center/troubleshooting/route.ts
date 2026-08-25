import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findKnownProblems, listTroubleshootingRecords, upsertTroubleshootingRecord, type TroubleshootingRecord } from "@/lib/troubleshooting-memory";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const url = new URL(req.url); const query = url.searchParams.get("q"); const affectedSystem = url.searchParams.get("system");
    if (query || affectedSystem) return NextResponse.json({ matches: await findKnownProblems({ affectedSystem: affectedSystem ?? "Hermes OS", symptoms: query ? [query] : [] }) });
    return NextResponse.json({ records: await listTroubleshootingRecords(), updatedAt: new Date().toISOString() });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Troubleshooting memory unavailable." }, { status: 503 }); }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as { record?: Partial<TroubleshootingRecord> & { title?: string; affectedSystem?: string } } | null;
  if (!body?.record?.title?.trim() || !body.record.affectedSystem?.trim()) return NextResponse.json({ error: "title and affectedSystem are required" }, { status: 400 });
  try { return NextResponse.json({ record: await upsertTroubleshootingRecord(body.record as Partial<TroubleshootingRecord> & { title: string; affectedSystem: string }) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Troubleshooting record failed." }, { status: 400 }); }
}
