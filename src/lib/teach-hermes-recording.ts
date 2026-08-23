import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { appendTeachingEvent, redactTeachingText, type SemanticTeachingEvent } from "@/lib/teach-hermes";

export const RECORDING_EVENT_KINDS = ["navigate", "click", "fill", "select", "submit", "observe", "checkpoint"] as const;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const SENSITIVE_FIELD = /password|passcode|secret|token|api[-_ ]?key|authorization|credential|session|cookie|private[-_ ]?key|access[-_ ]?key/i;
export const RECORDING_REDACTED = "[REDACTED]";

export type SemanticTarget = NonNullable<SemanticTeachingEvent["target"]>;
export type RecordedBrowserEvent = SemanticTeachingEvent & { pageUrl: string };

export function isSensitiveFieldDescriptor(target: SemanticTarget): boolean {
  return target.inputType === "password" || [target.name, target.label, target.stableId, target.autocomplete, target.selectorHint].some((value) => value && SENSITIVE_FIELD.test(value));
}

function approvedOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Builder preview URL is invalid."); }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || !url.port || url.username || url.password) {
    throw new Error("Recording requires an allocated local Builder preview.");
  }
  return url.origin;
}

function safePageUrl(raw: string, origin: string): string {
  let url: URL;
  try { url = new URL(raw, origin); } catch { throw new Error("Recorded page URL is invalid."); }
  if (url.origin !== origin || url.protocol !== "http:") throw new Error("Recorded event is outside the approved preview origin.");
  return url.pathname.slice(0, 1000);
}

async function recordingContext(userId: string, sessionId: string) {
  const session = await prisma.skillTeachingSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Teaching session not found.");
  if (session.status !== "recording") throw new Error("Teaching session is not eligible for recording.");
  if (session.expiresAt <= new Date()) {
    await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { status: "expired", activeScopeKey: null, recordingActive: false, recordingStoppedAt: new Date() } });
    throw new Error("Teaching session has expired.");
  }
  if (!session.projectId) throw new Error("Browser recording requires a project-scoped teaching session.");
  const project = await prisma.project.findFirst({ where: { id: session.projectId, userId }, select: { id: true, localDevUrl: true, localPreviewStatus: true } });
  if (!project) throw new Error("Project not found for this user.");
  if (project.localPreviewStatus !== "online" || !project.localDevUrl) throw new Error("The selected Builder preview is not approved and online.");
  return { session, project, origin: approvedOrigin(project.localDevUrl) };
}

async function assertPreviewResponds(origin: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(origin, { method: "GET", redirect: "manual", signal: controller.signal });
    if (!response.ok) throw new Error("Preview did not return a successful response.");
  } catch {
    throw new Error("The approved Builder preview is not reachable.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function startTeachingRecording(userId: string, sessionId: string) {
  const { session, project, origin } = await recordingContext(userId, sessionId);
  await assertPreviewResponds(origin);
  if (session.recordingActive && session.recordingNonce && session.recordingOrigin === origin) return { session, projectId: project.id, origin, nonce: session.recordingNonce };
  const nonce = crypto.randomUUID();
  const updated = await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { recordingActive: true, recordingNonce: nonce, recordingOrigin: origin, recordingLastSequence: 0, recordingStartedAt: new Date(), recordingStoppedAt: null } });
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.recording.started", resourceType: "SkillTeachingSession", resourceId: session.id, detail: `project=${project.id}; origin=${origin}` } });
  return { session: updated, projectId: project.id, origin, nonce };
}

export async function appendRecordedBrowserEvent(userId: string, input: { sessionId: string; nonce: string; browserSequence: number; event: RecordedBrowserEvent }) {
  const { session, origin } = await recordingContext(userId, input.sessionId);
  if (!session.recordingActive || !session.recordingNonce || session.recordingNonce !== input.nonce || session.recordingOrigin !== origin) throw new Error("Browser recording is not active for this session.");
  if (!Number.isSafeInteger(input.browserSequence) || input.browserSequence < 1) throw new Error("Browser event sequence is invalid.");
  if (!input.event || typeof input.event !== "object" || !RECORDING_EVENT_KINDS.includes(input.event.kind)) throw new Error("Unsupported recorded semantic event.");
  const eventKey = `${session.recordingNonce}:${input.browserSequence}`;
  if (input.browserSequence <= session.recordingLastSequence) {
    const existing = await prisma.skillTeachingEvent.findUnique({ where: { sessionId_eventKey: { sessionId: session.id, eventKey } } });
    if (existing) return { event: existing, duplicate: true };
    throw new Error("Browser event sequence is stale.");
  }
  if (input.browserSequence !== session.recordingLastSequence + 1) throw new Error("Browser event sequence is out of order.");
  const pagePath = safePageUrl(input.event.pageUrl, origin);
  const target = input.event.target;
  const safeEvent: SemanticTeachingEvent = {
    kind: input.event.kind,
    ...(target && { target }),
    ...(input.event.value !== undefined && { value: input.event.kind === "fill" && isSensitiveFieldDescriptor(target ?? {}) ? RECORDING_REDACTED : input.event.value }),
    ...(input.event.text !== undefined && { text: input.event.text }),
    url: pagePath,
    metadata: { ...(input.event.metadata ?? {}), browserSequence: input.browserSequence },
  };
  const result = await appendTeachingEvent(userId, session.id, eventKey, safeEvent);
  await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { recordingLastSequence: input.browserSequence } });
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.event.recorded", resourceType: "SkillTeachingEvent", resourceId: result.event.id, detail: `kind=${result.event.kind}; sequence=${input.browserSequence}; hash=${result.event.evidenceHash ?? "none"}` } });
  return result;
}

export async function stopTeachingRecording(userId: string, sessionId: string) {
  const session = await prisma.skillTeachingSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Teaching session not found.");
  if (session.expiresAt <= new Date()) {
    return prisma.skillTeachingSession.update({ where: { id: session.id }, data: { status: "expired", activeScopeKey: null, recordingActive: false, recordingStoppedAt: new Date() } });
  }
  if (session.status !== "recording") throw new Error("Teaching session is not eligible for recording.");
  if (!session.recordingActive) return session;
  const updated = await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { recordingActive: false, recordingStoppedAt: new Date() } });
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.recording.stopped", resourceType: "SkillTeachingSession", resourceId: session.id, detail: `events=${session.recordingLastSequence}` } });
  return updated;
}

export function sanitizeBrowserValue(value: unknown, target: SemanticTarget): string {
  return isSensitiveFieldDescriptor(target) ? RECORDING_REDACTED : redactTeachingText(value, target.name ?? target.label ?? "value", 1000);
}
