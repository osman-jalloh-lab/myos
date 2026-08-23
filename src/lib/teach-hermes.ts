import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { createApproval, rejectAction } from "@/lib/approvals";
import { clearSkillRegistryCache } from "@/lib/skills/registry";
import { calculateSkillQualityScore } from "@/lib/skills/quality";
import type { SkillDefinitionV2 } from "@/lib/skills/types";
import { ensureRegistryInitialized, getToolRegistration } from "@/lib/hermes-execution/tool-registry";

export const TEACHING_EVENT_KINDS = ["navigate", "click", "fill", "select", "submit", "observe", "checkpoint"] as const;
export type TeachingEventKind = typeof TEACHING_EVENT_KINDS[number];
export type TeachingSessionStatus = "recording" | "processing" | "draft" | "pending_approval" | "approved" | "expired" | "rejected" | "failed" | "disabled";
export type SkillDraftStatus = "draft" | "pending_approval" | "approved" | "expired" | "rejected" | "failed" | "disabled";

export type SemanticTeachingEvent = {
  kind: TeachingEventKind;
  target?: { role?: string; name?: string; label?: string; stableId?: string; selectorHint?: string; tag?: string; inputType?: string; autocomplete?: string };
  value?: string;
  text?: string;
  url?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

type CandidateExecution = { tool?: string; risk?: unknown; requiresApproval?: unknown };
export type TaughtSkillCandidate = SkillDefinitionV2 & {
  instructions?: string;
  execution?: CandidateExecution;
};

const SECRET_FIELD_RE = /password|passcode|secret|token|api[-_ ]?key|authorization|cookie|session|credential|private[-_ ]?key|clipboard/i;
const SECRET_VALUE_RE = /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}|[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|AUTH)[A-Z0-9_]*\s*[:=]\s*\S+)/i;
const CREDENTIAL_SHAPED_RE = /\b(?:secret|token|password|credential|access[-_]?key|private[-_]?key)[-_][A-Za-z0-9_-]{6,}\b/gi;
const REDACTED = "[REDACTED]";

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function redactTeachingText(value: unknown, fieldName = "text", max = 2000): string {
  const text = cleanText(value, max);
  if (!text) return "";
  if (SECRET_FIELD_RE.test(fieldName) || SECRET_VALUE_RE.test(text)) return REDACTED;
  return text
    .replace(/(?:postgres|mysql|libsql|mongodb|redis):\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, REDACTED)
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*["']?[^"'\s,;]+/gi, `$1=${REDACTED}`)
    .replace(/(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(CREDENTIAL_SHAPED_RE, REDACTED)
    .slice(0, max);
}

export function sanitizeSemanticTeachingEvent(input: SemanticTeachingEvent): SemanticTeachingEvent {
  if (!TEACHING_EVENT_KINDS.includes(input.kind)) throw new Error("Unsupported semantic teaching event kind.");
  if (!input || typeof input !== "object") throw new Error("Semantic teaching event is required.");
  const target = input.target ? {
    role: redactTeachingText(input.target.role, "role", 80) || undefined,
    name: redactTeachingText(input.target.name, "name", 160) || undefined,
    label: redactTeachingText(input.target.label, "label", 160) || undefined,
    stableId: redactTeachingText(input.target.stableId, "stableId", 120) || undefined,
    selectorHint: redactTeachingText(input.target.selectorHint, "selectorHint", 200) || undefined,
    tag: redactTeachingText(input.target.tag, "tag", 40) || undefined,
    inputType: redactTeachingText(input.target.inputType, "inputType", 40) || undefined,
    autocomplete: redactTeachingText(input.target.autocomplete, "autocomplete", 80) || undefined,
  } : undefined;
  const sensitiveFill = input.kind === "fill" && Boolean(
    target?.inputType && /password|hidden/i.test(target.inputType)
    || [target?.name, target?.label, target?.stableId, target?.autocomplete].some((value) => value && SECRET_FIELD_RE.test(value))
  );
  const metadata = input.metadata
    ? Object.fromEntries(Object.entries(input.metadata).slice(0, 20).map(([key, value]) => [
      redactTeachingText(key, "metadataKey", 80),
      typeof value === "number" || typeof value === "boolean" || value === null ? value : redactTeachingText(value, key, 300),
    ]))
    : undefined;
  return {
    kind: input.kind,
    ...(target && { target }),
    ...(input.value !== undefined && { value: sensitiveFill ? REDACTED : redactTeachingText(input.value, target?.name ?? "value", 1000) }),
    ...(input.text !== undefined && { text: redactTeachingText(input.text, "text", 1000) }),
    ...(input.url !== undefined && { url: redactTeachingText(input.url, "url", 1000) }),
    ...(metadata && { metadata }),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "taught-skill";
}

function stringArray(value: unknown, field: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be a string array.`);
  const values = value.map((item) => redactTeachingText(item, field, 500)).filter(Boolean);
  if (values.length < minimum) throw new Error(`${field} is incomplete.`);
  return values;
}

export function validateTaughtSkillCandidate(input: TaughtSkillCandidate): TaughtSkillCandidate {
  if (!input || typeof input !== "object") throw new Error("Skill definition is required.");
  const definition: TaughtSkillCandidate = {
    ...input,
    id: slugify(redactTeachingText(input.id || input.name, "skillId", 100)),
    name: redactTeachingText(input.name, "name", 120),
    description: redactTeachingText(input.description, "description", 500),
    category: redactTeachingText(input.category || "workflow", "category", 80),
    purpose: redactTeachingText(input.purpose, "purpose", 1000),
    version: redactTeachingText(input.version || "1.0.0", "version", 40),
    ownerAgents: stringArray(input.ownerAgents, "ownerAgents", 1),
    tags: stringArray(input.tags, "tags"),
    whenToUse: stringArray(input.whenToUse, "whenToUse", 1),
    whenNotToUse: stringArray(input.whenNotToUse, "whenNotToUse", 1),
    strongSignals: stringArray(input.strongSignals, "strongSignals", 1),
    weakSignals: stringArray(input.weakSignals, "weakSignals"),
    negativeSignals: stringArray(input.negativeSignals, "negativeSignals", 1),
    requiredContext: stringArray(input.requiredContext, "requiredContext"),
    missingContextQuestions: stringArray(input.missingContextQuestions, "missingContextQuestions"),
    safetyRules: stringArray(input.safetyRules, "safetyRules", 1),
    approvalRequiredFor: stringArray(input.approvalRequiredFor, "approvalRequiredFor"),
    positiveExamples: stringArray(input.positiveExamples, "positiveExamples"),
    negativeExamples: stringArray(input.negativeExamples, "negativeExamples"),
    outputContract: input.outputContract ? {
      format: redactTeachingText(input.outputContract.format, "outputFormat", 500),
      mustInclude: stringArray(input.outputContract.mustInclude, "mustInclude"),
      mustAvoid: stringArray(input.outputContract.mustAvoid, "mustAvoid"),
      ...(input.outputContract.tone && { tone: redactTeachingText(input.outputContract.tone, "tone", 200) }),
    } : input.outputContract,
    evaluationPrompts: Array.isArray(input.evaluationPrompts) ? input.evaluationPrompts.map((prompt) => ({
      input: redactTeachingText(prompt.input, "evaluationInput", 1000),
      shouldMatch: Boolean(prompt.shouldMatch),
      ...(typeof prompt.minimumScore === "number" && { minimumScore: prompt.minimumScore }),
      ...(prompt.expectedSkill && { expectedSkill: redactTeachingText(prompt.expectedSkill, "expectedSkill", 120) }),
      reason: redactTeachingText(prompt.reason, "evaluationReason", 500),
    })) : input.evaluationPrompts,
    ...(input.instructions !== undefined && { instructions: redactTeachingText(input.instructions, "instructions", 12_000) }),
    ...(input.execution && { execution: { tool: redactTeachingText(input.execution.tool, "tool", 160) || undefined } }),
  };
  if (!definition.name || !definition.description || !definition.purpose) throw new Error("Skill name, description, and purpose are required.");
  if (!definition.outputContract || typeof definition.outputContract.format !== "string") throw new Error("A valid output contract is required.");
  if (!Array.isArray(definition.evaluationPrompts)) throw new Error("Evaluation prompts are required.");
  return definition;
}

type EffectiveCapabilities = {
  tool: string | null;
  risk: "read" | "internal_write" | "external_write" | null;
  requiresApproval: boolean;
  permissions: string[];
  availability: string | null;
};

export async function computeEffectiveCapabilities(candidate: TaughtSkillCandidate): Promise<EffectiveCapabilities> {
  const toolId = cleanText(candidate.execution?.tool, 160);
  if (!toolId) return { tool: null, risk: null, requiresApproval: false, permissions: [], availability: null };
  await ensureRegistryInitialized();
  const registered = getToolRegistration(toolId);
  if (!registered || registered.metadata.availability !== "available") {
    return { tool: null, risk: null, requiresApproval: false, permissions: [], availability: registered?.metadata.availability ?? "unavailable" };
  }
  const risk = registered.metadata.risk === "read" ? "read"
    : registered.metadata.risk === "write" ? "internal_write" : "external_write";
  return {
    tool: registered.toolId,
    risk,
    requiresApproval: registered.metadata.requiresApproval || risk === "external_write",
    permissions: [...registered.metadata.permissions],
    availability: registered.metadata.availability,
  };
}

async function assertProjectOwnership(userId: string, projectId?: string | null): Promise<void> {
  if (!projectId) return;
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (!project) throw new Error("Project not found for this user.");
}

export async function expireTeachingSessions(now = new Date()): Promise<number> {
  const result = await prisma.skillTeachingSession.updateMany({
    where: { status: "recording", expiresAt: { lte: now } },
    data: { status: "expired", stoppedAt: now, activeScopeKey: null, recordingActive: false, recordingStoppedAt: now },
  });
  return result.count;
}

export async function startTeachingSession(userId: string, input: { goal: string; projectId?: string | null; ttlMs?: number }) {
  await assertProjectOwnership(userId, input.projectId);
  await expireTeachingSessions();
  const active = await prisma.skillTeachingSession.findFirst({
    where: { userId, projectId: input.projectId ?? null, status: "recording", expiresAt: { gt: new Date() } },
  });
  if (active) return active;
  const ttlMs = Math.min(Math.max(input.ttlMs ?? 30 * 60_000, 60_000), 24 * 60 * 60_000);
  const goal = redactTeachingText(input.goal, "goal", 1000);
  if (!goal) throw new Error("Teaching goal is required.");
  const activeScopeKey = `${userId}:${input.projectId ?? "global"}`;
  try {
    return await prisma.skillTeachingSession.create({ data: { userId, projectId: input.projectId ?? null, activeScopeKey, goal, expiresAt: new Date(Date.now() + ttlMs) } });
  } catch (error) {
    const concurrent = await prisma.skillTeachingSession.findFirst({ where: { activeScopeKey, status: "recording", expiresAt: { gt: new Date() } } });
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function getCurrentTeachingSession(userId: string, projectId?: string | null) {
  await assertProjectOwnership(userId, projectId);
  await expireTeachingSessions();
  return prisma.skillTeachingSession.findFirst({
    where: { userId, projectId: projectId ?? null, status: "recording", expiresAt: { gt: new Date() } },
    orderBy: { startedAt: "desc" },
  });
}

async function ownedSession(userId: string, sessionId: string) {
  const session = await prisma.skillTeachingSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Teaching session not found.");
  await assertProjectOwnership(userId, session.projectId);
  if (session.status === "recording" && session.expiresAt <= new Date()) {
    await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { status: "expired", stoppedAt: new Date(), activeScopeKey: null } });
    throw new Error("Teaching session has expired.");
  }
  return session;
}

export async function appendTeachingEvent(userId: string, sessionId: string, eventKey: string, input: SemanticTeachingEvent) {
  const session = await ownedSession(userId, sessionId);
  if (session.status !== "recording") throw new Error("Teaching session is not recording.");
  const key = cleanText(eventKey, 160);
  if (!key) throw new Error("eventKey is required.");
  const existing = await prisma.skillTeachingEvent.findUnique({ where: { sessionId_eventKey: { sessionId, eventKey: key } } });
  if (existing) return { event: existing, duplicate: true };
  const safe = sanitizeSemanticTeachingEvent(input);
  const payload = JSON.stringify(safe);
  const evidenceHash = crypto.createHash("sha256").update(payload).digest("hex");
  const aggregate = await prisma.skillTeachingEvent.aggregate({ where: { sessionId }, _max: { sequence: true } });
  try {
    const event = await prisma.skillTeachingEvent.create({ data: { sessionId, sequence: (aggregate._max.sequence ?? 0) + 1, eventKey: key, kind: safe.kind, payload, evidenceHash } });
    return { event, duplicate: false };
  } catch (error) {
    const duplicate = await prisma.skillTeachingEvent.findUnique({ where: { sessionId_eventKey: { sessionId, eventKey: key } } });
    if (duplicate) return { event: duplicate, duplicate: true };
    throw error;
  }
}

export async function stopTeachingSession(userId: string, sessionId: string) {
  const session = await ownedSession(userId, sessionId);
  if (session.status !== "recording") return session;
  return prisma.skillTeachingSession.update({ where: { id: session.id }, data: { status: "processing", stoppedAt: new Date(), activeScopeKey: null, recordingActive: false, recordingStoppedAt: new Date() } });
}

export async function createSkillDraft(userId: string, input: { sessionId: string; candidate: TaughtSkillCandidate; observedCapabilities?: string[]; confidence: number; provenance?: Record<string, unknown> }) {
  const session = await ownedSession(userId, input.sessionId);
  if (["expired", "rejected", "failed", "disabled"].includes(session.status)) throw new Error(`Cannot draft from a ${session.status} session.`);
  const definition = validateTaughtSkillCandidate(input.candidate);
  const effective = await computeEffectiveCapabilities(definition);
  const observed = [...new Set((input.observedCapabilities ?? []).map((item) => redactTeachingText(item, "capability", 160)).filter(Boolean))];
  const confidence = Math.min(Math.max(Number(input.confidence) || 0, 0), 1);
  const safeProvenance = Object.fromEntries(Object.entries(input.provenance ?? {}).slice(0, 30).map(([key, value]) => [
    redactTeachingText(key, "provenanceKey", 80),
    redactTeachingText(value, key, 500),
  ]));
  const provenance = JSON.stringify({ source: "teach-hermes", sessionId: session.id, ...safeProvenance });
  const draft = await prisma.skillDraft.upsert({
    where: { sessionId: session.id },
    create: { sessionId: session.id, userId, projectId: session.projectId, name: definition.name, definition: JSON.stringify(definition), observedCapabilities: JSON.stringify(observed), effectiveCapabilities: JSON.stringify(effective), confidence, provenance, status: "draft" },
    update: { name: definition.name, definition: JSON.stringify(definition), observedCapabilities: JSON.stringify(observed), effectiveCapabilities: JSON.stringify(effective), confidence, provenance, status: "draft", revision: { increment: 1 }, approvalId: null },
  });
  await prisma.skillTeachingSession.update({ where: { id: session.id }, data: { status: "draft", stoppedAt: session.stoppedAt ?? new Date() } });
  return draft;
}

export async function getSkillDraft(userId: string, draftId: string) {
  const draft = await prisma.skillDraft.findFirst({ where: { id: draftId, userId } });
  if (!draft) throw new Error("Skill draft not found.");
  await assertProjectOwnership(userId, draft.projectId);
  return draft;
}

export async function updateSkillDraft(userId: string, draftId: string, expectedRevision: number, candidate: TaughtSkillCandidate) {
  const draft = await getSkillDraft(userId, draftId);
  if (draft.status !== "draft") throw new Error("Only draft skills can be edited.");
  if (draft.revision !== expectedRevision) throw new Error("Skill draft revision is stale.");
  const definition = validateTaughtSkillCandidate(candidate);
  const effective = await computeEffectiveCapabilities(definition);
  const updated = await prisma.skillDraft.updateMany({
    where: { id: draft.id, userId, revision: expectedRevision, status: "draft" },
    data: { name: definition.name, definition: JSON.stringify(definition), effectiveCapabilities: JSON.stringify(effective), revision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error("Skill draft revision is stale.");
  return getSkillDraft(userId, draft.id);
}

export async function requestSkillDraftApproval(userId: string, draftId: string) {
  const draft = await getSkillDraft(userId, draftId);
  if (draft.status === "approved") return { draft, approval: null };
  if (draft.status === "pending_approval" && draft.approvalId) {
    const approval = await prisma.approvalAction.findFirst({ where: { id: draft.approvalId, userId } });
    return { draft, approval };
  }
  if (draft.status !== "draft") throw new Error(`Cannot request approval for a ${draft.status} draft.`);
  const approval = await createApproval(userId, "teach_skill_promote", { draftId: draft.id, revision: draft.revision, sessionId: draft.sessionId });
  const updated = await prisma.skillDraft.update({ where: { id: draft.id }, data: { status: "pending_approval", approvalId: approval.id } });
  await prisma.skillTeachingSession.update({ where: { id: draft.sessionId }, data: { status: "pending_approval" } });
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.approval.requested", resourceType: "SkillDraft", resourceId: draft.id, detail: `revision=${draft.revision}; approval=${approval.id}` } });
  return { draft: updated, approval };
}

export async function rejectSkillDraft(userId: string, draftId: string) {
  const draft = await getSkillDraft(userId, draftId);
  if (draft.status === "rejected") return draft;
  if (draft.status === "approved") throw new Error("Approved skill drafts cannot be rejected.");
  if (draft.approvalId) {
    const approval = await prisma.approvalAction.findFirst({ where: { id: draft.approvalId, userId } });
    if (approval?.status === "pending") await rejectAction(userId, approval.id);
  }
  const updated = await prisma.skillDraft.update({ where: { id: draft.id }, data: { status: "rejected" } });
  await prisma.skillTeachingSession.update({ where: { id: draft.sessionId }, data: { status: "rejected" } });
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.draft.rejected", resourceType: "SkillDraft", resourceId: draft.id, detail: "Teach Hermes draft rejected; evidence preserved." } });
  return updated;
}

export async function markSkillDraftRejectedFromApproval(userId: string, draftId: string, approvalId: string) {
  const draft = await getSkillDraft(userId, draftId);
  if (draft.approvalId !== approvalId) throw new Error("Approval does not belong to this skill draft.");
  if (draft.status === "approved") throw new Error("Approved skill drafts cannot be rejected.");
  const updated = await prisma.skillDraft.update({ where: { id: draft.id }, data: { status: "rejected" } });
  await prisma.skillTeachingSession.update({ where: { id: draft.sessionId }, data: { status: "rejected" } });
  return updated;
}

export async function promoteApprovedSkillDraft(userId: string, draftId: string, approvalId: string) {
  const draft = await getSkillDraft(userId, draftId);
  if (draft.status === "approved" && draft.promotedSkillId) {
    return prisma.userSkill.findFirstOrThrow({ where: { userId, skillId: draft.promotedSkillId } });
  }
  if (draft.status !== "pending_approval" || draft.approvalId !== approvalId) throw new Error("Skill draft is not awaiting this approval.");
  const approval = await prisma.approvalAction.findFirst({ where: { id: approvalId, userId, actionType: "teach_skill_promote", status: "approved" } });
  if (!approval) throw new Error("An approved Teach Hermes promotion is required.");
  const payload = parseJson<{ draftId?: string; revision?: number }>(approval.payload);
  if (payload.draftId !== draft.id || payload.revision !== draft.revision) throw new Error("Approval does not match the latest skill draft revision.");
  const candidate = validateTaughtSkillCandidate(parseJson<TaughtSkillCandidate>(draft.definition));
  const quality = calculateSkillQualityScore(candidate);
  if (quality.score < 60) throw new Error(`Skill quality is too low for promotion (${quality.score}/100).`);
  const effective = await computeEffectiveCapabilities(candidate);
  const promotedDefinition: Record<string, unknown> = {
    ...candidate,
    instructions: candidate.instructions ?? candidate.purpose,
    provenance: { source: "teach-hermes", teachingSessionId: draft.sessionId, skillDraftId: draft.id, revision: draft.revision, confidence: draft.confidence },
  };
  if (effective.tool) promotedDefinition.execution = { tool: effective.tool, risk: effective.risk, requiresApproval: effective.requiresApproval };
  else delete promotedDefinition.execution;
  const skillId = candidate.id;
  const promoted = await prisma.$transaction(async (tx) => {
    const latest = await tx.skillDraft.findFirst({ where: { id: draft.id, userId } });
    if (!latest) throw new Error("Skill draft not found.");
    if (latest.status === "approved" && latest.promotedSkillId) return tx.userSkill.findFirstOrThrow({ where: { userId, skillId: latest.promotedSkillId } });
    if (latest.revision !== draft.revision || latest.status !== "pending_approval") throw new Error("Skill draft changed before promotion.");
    const skill = await tx.userSkill.upsert({
      where: { userId_skillId: { userId, skillId } },
      create: { userId, skillId, name: candidate.name, description: candidate.description, category: candidate.category, definition: JSON.stringify(promotedDefinition), enabled: true },
      update: { name: candidate.name, description: candidate.description, category: candidate.category, definition: JSON.stringify(promotedDefinition), enabled: true },
    });
    await tx.skillDraft.update({ where: { id: draft.id }, data: { status: "approved", promotedSkillId: skillId, effectiveCapabilities: JSON.stringify(effective) } });
    await tx.skillTeachingSession.update({ where: { id: draft.sessionId }, data: { status: "approved" } });
    await tx.auditLog.create({ data: { userId, action: "promoted", resourceType: "SkillDraft", resourceId: draft.id, detail: `Approved Teach Hermes draft promoted to UserSkill ${skillId}.` } });
    await tx.auditLog.create({ data: { userId, action: "skill.teaching.skill.promoted", resourceType: "UserSkill", resourceId: skill.id, detail: `draft=${draft.id}; revision=${draft.revision}; skill=${skillId}` } });
    return skill;
  });
  clearSkillRegistryCache(userId);
  return promoted;
}
