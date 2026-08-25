import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { traceVoiceEvent } from "@/lib/voice-service";
export async function POST(req: Request) { const session = await auth(); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const body = await req.json().catch(() => null) as { runId?: string; event?: string; details?: Record<string, unknown> } | null; if (!body?.runId || !body.event) return NextResponse.json({ error: "runId and event are required" }, { status: 400 }); try { await traceVoiceEvent(session.user.id, body.runId, body.event, body.details); return NextResponse.json({ recorded: true }); } catch { return NextResponse.json({ error: "Voice event rejected" }, { status: 400 }); } }
