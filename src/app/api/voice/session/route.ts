import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createVoiceSession } from "@/lib/voice-service";
export async function POST() { const session = await auth(); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); try { return NextResponse.json(await createVoiceSession(session.user.id)); } catch (error) { console.error("[/api/voice/session] unavailable", error instanceof Error ? error.message : "unknown"); return NextResponse.json({ error: "Voice provider unavailable" }, { status: 503 }); } }
