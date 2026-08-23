import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  appendTeachingEvent,
  createSkillDraft,
  getCurrentTeachingSession,
  getSkillDraft,
  rejectSkillDraft,
  promoteApprovedSkillDraft,
  requestSkillDraftApproval,
  startTeachingSession,
  stopTeachingSession,
  updateSkillDraft,
  type SemanticTeachingEvent,
  type TaughtSkillCandidate,
} from "@/lib/teach-hermes";
import { appendRecordedBrowserEvent, startTeachingRecording, stopTeachingRecording, type RecordedBrowserEvent } from "@/lib/teach-hermes-recording";
import { generateTeachingSkillDraft } from "@/lib/teach-hermes-generation";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const draftId = url.searchParams.get("draftId");
  try {
    if (draftId) return NextResponse.json({ draft: await getSkillDraft(session.user.id, draftId) });
    return NextResponse.json({ session: await getCurrentTeachingSession(session.user.id, url.searchParams.get("projectId")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Teach Hermes request failed." }, { status: 404 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action is required" }, { status: 400 });
  const userId = session.user.id;
  try {
    switch (body.action) {
      case "start":
        return NextResponse.json({ session: await startTeachingSession(userId, { goal: String(body.goal ?? ""), projectId: typeof body.projectId === "string" ? body.projectId : null }) });
      case "appendEvent":
        return NextResponse.json(await appendTeachingEvent(userId, String(body.sessionId ?? ""), String(body.eventKey ?? ""), body.event as SemanticTeachingEvent));
      case "stop":
        return NextResponse.json({ session: await stopTeachingSession(userId, String(body.sessionId ?? "")) });
      case "startRecording":
        return NextResponse.json(await startTeachingRecording(userId, String(body.sessionId ?? "")));
      case "recordEvent":
        return NextResponse.json(await appendRecordedBrowserEvent(userId, { sessionId: String(body.sessionId ?? ""), nonce: String(body.nonce ?? ""), browserSequence: Number(body.browserSequence), event: body.event as RecordedBrowserEvent }));
      case "stopRecording":
        return NextResponse.json({ session: await stopTeachingRecording(userId, String(body.sessionId ?? "")) });
      case "generateDraft":
        return NextResponse.json(await generateTeachingSkillDraft(userId, { sessionId: String(body.sessionId ?? ""), requestKey: String(body.requestKey ?? "") }));
      case "createDraft":
        return NextResponse.json({ draft: await createSkillDraft(userId, { sessionId: String(body.sessionId ?? ""), candidate: body.candidate as TaughtSkillCandidate, observedCapabilities: Array.isArray(body.observedCapabilities) ? body.observedCapabilities.map(String) : [], confidence: Number(body.confidence ?? 0), provenance: typeof body.provenance === "object" && body.provenance ? body.provenance as Record<string, unknown> : undefined }) });
      case "updateDraft":
        return NextResponse.json({ draft: await updateSkillDraft(userId, String(body.draftId ?? ""), Number(body.revision), body.candidate as TaughtSkillCandidate) });
      case "requestApproval":
        return NextResponse.json(await requestSkillDraftApproval(userId, String(body.draftId ?? "")));
      case "promoteApproved":
        return NextResponse.json({ skill: await promoteApprovedSkillDraft(userId, String(body.draftId ?? ""), String(body.approvalId ?? "")) });
      case "rejectDraft":
        return NextResponse.json({ draft: await rejectSkillDraft(userId, String(body.draftId ?? "")) });
      default:
        return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Teach Hermes request failed." }, { status: 409 });
  }
}
