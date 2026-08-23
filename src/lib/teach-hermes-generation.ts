import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { callModel, type ModelCallResult } from "@/lib/modelRouter";
import { calculateSkillQualityScore } from "@/lib/skills/quality";
import {
  createSkillDraft,
  redactTeachingText,
  sanitizeSemanticTeachingEvent,
  validateTaughtSkillCandidate,
  type SemanticTeachingEvent,
  type TaughtSkillCandidate,
} from "@/lib/teach-hermes";

const MAX_EVIDENCE_EVENTS = 100;
const MAX_EVIDENCE_CHARS = 30_000;

export type TeachingEvidenceAction = {
  sequence: number;
  kind: SemanticTeachingEvent["kind"];
  summary: string;
  eventId: string;
  evidenceHash: string | null;
};

export type TeachingEvidence = {
  teachingSessionId: string;
  goal: string;
  project: { id: string; name: string };
  actions: TeachingEvidenceAction[];
  observations: string[];
  evidenceDigest: string;
};

export type DraftGenerationEnvelope = {
  candidate: TaughtSkillCandidate;
  confidence: number;
  warnings?: string[];
};

export type DraftModel = (input: { systemPrompt: string; userPrompt: string; userId: string }) => Promise<ModelCallResult>;

function parseEvent(payload: string): SemanticTeachingEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { throw new Error("Stored teaching evidence is malformed."); }
  if (!parsed || typeof parsed !== "object") throw new Error("Stored teaching evidence is malformed.");
  return sanitizeSemanticTeachingEvent(parsed as SemanticTeachingEvent);
}

function eventSummary(event: SemanticTeachingEvent): string {
  const target = event.target?.name || event.target?.label || event.target?.role || event.target?.stableId || "page";
  if (event.kind === "navigate") return `navigate to ${event.url || "/"}`;
  if (event.kind === "click") return `click ${JSON.stringify(target)}`;
  if (event.kind === "fill") return `fill ${JSON.stringify(target)} with ${event.value === "[REDACTED]" ? "[REDACTED]" : "a provided value"}`;
  if (event.kind === "select") return `select a provided option for ${JSON.stringify(target)}`;
  if (event.kind === "submit") return `submit ${JSON.stringify(target)}`;
  if (event.kind === "checkpoint") return `checkpoint ${JSON.stringify(event.text || "workflow state")}`;
  return `observe ${JSON.stringify(event.text || "safe page state")}`;
}

export async function assembleTeachingEvidence(userId: string, sessionId: string): Promise<TeachingEvidence> {
  const session = await prisma.skillTeachingSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Teaching session not found.");
  if (!session.projectId) throw new Error("Draft generation requires a project-scoped teaching session.");
  const project = await prisma.project.findFirst({ where: { id: session.projectId, userId }, select: { id: true, projectName: true } });
  if (!project) throw new Error("Project not found for this user.");
  const rows = await prisma.skillTeachingEvent.findMany({ where: { sessionId }, orderBy: { sequence: "asc" }, take: MAX_EVIDENCE_EVENTS + 1 });
  if (!rows.length) throw new Error("Teaching session has no recorded evidence.");
  if (rows.length > MAX_EVIDENCE_EVENTS) throw new Error("Teaching evidence exceeds the bounded event limit.");
  const actions = rows.map((row) => {
    const event = parseEvent(row.payload);
    return { sequence: row.sequence, kind: event.kind, summary: redactTeachingText(eventSummary(event), "evidence", 500), eventId: row.id, evidenceHash: row.evidenceHash };
  });
  const observations = rows.map((row) => parseEvent(row.payload)).filter((event) => event.kind === "observe" || event.kind === "checkpoint").map((event) => redactTeachingText(event.text, "observation", 500)).filter(Boolean);
  const evidence = {
    teachingSessionId: session.id,
    goal: redactTeachingText(session.goal, "goal", 1000),
    project: { id: project.id, name: redactTeachingText(project.projectName, "projectName", 160) },
    actions,
    observations,
  };
  const serialized = JSON.stringify(evidence);
  if (serialized.length > MAX_EVIDENCE_CHARS) throw new Error("Teaching evidence exceeds the bounded prompt limit.");
  return { ...evidence, evidenceDigest: crypto.createHash("sha256").update(serialized).digest("hex") };
}

export function parseDraftGenerationEnvelope(text: string): DraftGenerationEnvelope {
  const source = text.trim();
  if (!source.startsWith("{") || !source.endsWith("}")) throw new Error("Hermes draft generation did not return structured JSON.");
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("Hermes draft generation returned malformed JSON."); }
  if (!parsed || typeof parsed !== "object" || !("candidate" in parsed)) throw new Error("Hermes draft generation returned an invalid envelope.");
  const object = parsed as Record<string, unknown>;
  const candidate = validateTaughtSkillCandidate(object.candidate as TaughtSkillCandidate);
  const confidence = Number(object.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Hermes draft confidence is invalid.");
  const warnings = Array.isArray(object.warnings) ? object.warnings.map((warning) => redactTeachingText(warning, "generationWarning", 300)).filter(Boolean).slice(0, 20) : [];
  return { candidate, confidence, warnings };
}

function generationPrompts(evidence: TeachingEvidence) {
  const systemPrompt = `You are Hermes converting one bounded, redacted browser demonstration into an untrusted My OS SkillDefinitionV2 draft. Return ONLY one JSON object with keys candidate, confidence, warnings. Infer the reusable workflow and parameterize variable user data. Use requiredContext for inputs and instructions for ordered steps, validation, and failure handling. Do not replay fixture values. Do not invent actions, tools, permissions, filesystem access, Docker access, external-write authorization, or executable code. Preserve approval boundaries and explicitly state uncertainty. Never include secrets. Model-supplied risk or requiresApproval is advisory and will be discarded. The candidate must include every SkillDefinitionV2 field plus optional instructions and optional execution.tool. Include at least five evaluationPrompts.`;
  const userPrompt = JSON.stringify({ goal: evidence.goal, project: evidence.project, orderedActions: evidence.actions.map(({ sequence, kind, summary, evidenceHash }) => ({ sequence, kind, summary, evidenceHash })), observations: evidence.observations, evidenceDigest: evidence.evidenceDigest });
  return { systemPrompt, userPrompt };
}

async function defaultDraftModel(input: { systemPrompt: string; userPrompt: string; userId: string }) {
  return callModel({ userId: input.userId, taskType: "teach-hermes-draft", dataClass: "PERSONAL", systemPrompt: input.systemPrompt, userPrompt: input.userPrompt });
}

function safeRequestKey(value: string): string {
  const key = redactTeachingText(value, "requestKey", 160);
  if (!key) throw new Error("requestKey is required.");
  return key;
}

function parseProvenance(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

export async function generateTeachingSkillDraft(userId: string, input: { sessionId: string; requestKey: string }, model: DraftModel = defaultDraftModel) {
  const requestKey = safeRequestKey(input.requestKey);
  const session = await prisma.skillTeachingSession.findFirst({ where: { id: input.sessionId, userId } });
  if (!session) throw new Error("Teaching session not found.");
  if (session.recordingActive || session.status === "recording") throw new Error("Stop and finalize recording before generating a draft.");
  if (!["processing", "draft"].includes(session.status)) throw new Error(`Cannot generate a draft from a ${session.status} session.`);
  if (!session.projectId || !await prisma.project.findFirst({ where: { id: session.projectId, userId }, select: { id: true } })) throw new Error("Project not found for this user.");
  const existing = await prisma.skillDraft.findUnique({ where: { sessionId: session.id } });
  if (existing && parseProvenance(existing.provenance).generationRequestKey === requestKey) return { draft: existing, duplicate: true };
  const evidence = await assembleTeachingEvidence(userId, session.id);
  const prompts = generationPrompts(evidence);
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.processing.started", resourceType: "SkillTeachingSession", resourceId: session.id, detail: `events=${evidence.actions.length}; evidence=${evidence.evidenceDigest}` } });
  try {
    const response = await model({ ...prompts, userId });
    const generated = parseDraftGenerationEnvelope(response.text);
    const candidate: TaughtSkillCandidate = { ...generated.candidate };
    const requestedTool = candidate.execution?.tool ? redactTeachingText(candidate.execution.tool, "tool", 160) : null;
    // Browser demonstrations observe semantic behavior; they do not grant an executable tool.
    delete candidate.execution;
    const quality = calculateSkillQualityScore(candidate);
    const warnings = [...generated.warnings ?? [], ...(requestedTool ? [`Requested tool ${requestedTool} was not granted from browser evidence.`] : []), ...quality.warnings];
    if (quality.score < 60) warnings.unshift(`Needs review: quality score ${quality.score}/100 (${quality.band}).`);
    const draft = await createSkillDraft(userId, {
      sessionId: session.id,
      candidate,
      observedCapabilities: [...new Set(evidence.actions.map((action) => `browser.semantic.${action.kind}`))],
      confidence: generated.confidence,
      provenance: {
        generationRequestKey: requestKey,
        evidenceDigest: evidence.evidenceDigest,
        eventIds: evidence.actions.map((action) => action.eventId).join(","),
        eventHashes: evidence.actions.map((action) => action.evidenceHash).filter(Boolean).join(","),
        generatedAt: new Date().toISOString(),
        provider: response.provider,
        modelTask: "teach-hermes-draft",
        qualityScore: quality.score,
        qualityBand: quality.band,
        reviewState: quality.score >= 60 && generated.confidence >= 0.65 ? "ready_for_review" : "needs_review",
        warnings: warnings.join(" | "),
      },
    });
    await prisma.auditLog.create({ data: { userId, action: "skill.teaching.draft.generated", resourceType: "SkillDraft", resourceId: draft.id, detail: `revision=${draft.revision}; provider=${response.provider}; quality=${quality.score}; confidence=${generated.confidence}; evidence=${evidence.evidenceDigest}` } });
    return { draft, duplicate: false };
  } catch (error) {
    await prisma.auditLog.create({ data: { userId, action: "skill.teaching.draft.generation_failed", resourceType: "SkillTeachingSession", resourceId: session.id, detail: `evidence=${evidence.evidenceDigest}; error=${redactTeachingText(error instanceof Error ? error.message : "generation failed", "error", 300)}` } });
    throw error;
  }
}
