import { prisma } from "@/lib/db";
import { calculateSkillQualityScore } from "@/lib/skills/quality";
import { assembleTeachingEvidence } from "@/lib/teach-hermes-generation";
import {
  getSkillDraft,
  redactTeachingText,
  updateSkillDraft,
  validateTaughtSkillCandidate,
  type TaughtSkillCandidate,
} from "@/lib/teach-hermes";

export type TeachingDraftReviewEdit = {
  name: string;
  description: string;
  purpose: string;
  whenToUse: string[];
  requiredContext: string[];
  instructions: string;
  outputFormat: string;
  outputMustInclude: string[];
  outputMustAvoid: string[];
};

export type TeachingDraftReview = {
  id: string;
  sessionId: string;
  projectId: string | null;
  projectName: string;
  status: string;
  trustLabel: "DRAFT — NOT ACTIVE" | "PENDING APPROVAL" | "APPROVED / ACTIVE" | "REJECTED" | "NEEDS REVIEW";
  revision: number;
  confidence: number;
  quality: { score: number; band: string; status: "ready_for_review" | "needs_review"; warnings: string[] };
  editable: TeachingDraftReviewEdit;
  safetyRules: string[];
  approvalRequiredFor: string[];
  effectiveCapabilitySummary: string;
  evidence: { eventCount: number; summary: string[] };
  promotedSkillId: string | null;
  approvalId: string | null;
};

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => redactTeachingText(item, "reviewText", 500)).filter(Boolean).slice(0, 50) : [];
}

function trustLabel(status: string, needsReview: boolean): TeachingDraftReview["trustLabel"] {
  if (status === "approved") return "APPROVED / ACTIVE";
  if (status === "pending_approval") return "PENDING APPROVAL";
  if (status === "rejected") return "REJECTED";
  if (needsReview) return "NEEDS REVIEW";
  return "DRAFT — NOT ACTIVE";
}

export async function getTeachingDraftReview(userId: string, draftId: string): Promise<TeachingDraftReview> {
  const draft = await getSkillDraft(userId, draftId);
  const definition = validateTaughtSkillCandidate(parseObject(draft.definition) as unknown as TaughtSkillCandidate);
  const quality = calculateSkillQualityScore(definition);
  const provenance = parseObject(draft.provenance);
  const generationWarnings = redactTeachingText(provenance.warnings, "warnings", 3000).split(" | ").filter(Boolean);
  const reviewState = provenance.reviewState === "needs_review" || quality.score < 60 || draft.confidence < 0.65 ? "needs_review" : "ready_for_review";
  const evidence = await assembleTeachingEvidence(userId, draft.sessionId);
  const effective = parseObject(draft.effectiveCapabilities);
  return {
    id: draft.id,
    sessionId: draft.sessionId,
    projectId: draft.projectId,
    projectName: evidence.project.name,
    status: draft.status,
    trustLabel: trustLabel(draft.status, reviewState === "needs_review"),
    revision: draft.revision,
    confidence: draft.confidence,
    quality: { score: quality.score, band: quality.band, status: reviewState, warnings: [...new Set([...generationWarnings, ...quality.warnings])].slice(0, 30) },
    editable: {
      name: definition.name,
      description: definition.description,
      purpose: definition.purpose,
      whenToUse: definition.whenToUse,
      requiredContext: definition.requiredContext,
      instructions: definition.instructions ?? definition.purpose,
      outputFormat: definition.outputContract.format,
      outputMustInclude: definition.outputContract.mustInclude,
      outputMustAvoid: definition.outputContract.mustAvoid,
    },
    safetyRules: definition.safetyRules,
    approvalRequiredFor: definition.approvalRequiredFor,
    effectiveCapabilitySummary: effective.tool ? `Registered tool: ${redactTeachingText(effective.tool, "tool", 160)}; normal My OS policy applies.` : "No executable tool granted. Normal My OS policy remains authoritative.",
    evidence: { eventCount: evidence.actions.length, summary: evidence.actions.map((action) => `${action.sequence}. ${action.summary}`).slice(0, 100) },
    promotedSkillId: draft.promotedSkillId,
    approvalId: draft.approvalId,
  };
}

export async function listTeachingDraftReviews(userId: string): Promise<TeachingDraftReview[]> {
  return (await listTeachingDraftReviewAvailability(userId)).reviews;
}

export async function listTeachingDraftReviewAvailability(userId: string): Promise<{ reviews: TeachingDraftReview[]; unavailableCount: number }> {
  const rows = await prisma.skillDraft.findMany({ where: { userId }, select: { id: true }, orderBy: { updatedAt: "desc" }, take: 20 });
  const reviews: TeachingDraftReview[] = [];
  let unavailableCount = 0;
  for (const row of rows) {
    try { reviews.push(await getTeachingDraftReview(userId, row.id)); }
    catch { unavailableCount += 1; }
  }
  return { reviews, unavailableCount };
}

export async function updateTeachingDraftReview(userId: string, draftId: string, expectedRevision: number, edit: TeachingDraftReviewEdit) {
  const draft = await getSkillDraft(userId, draftId);
  let existing: TaughtSkillCandidate;
  try { existing = validateTaughtSkillCandidate(JSON.parse(draft.definition) as TaughtSkillCandidate); }
  catch { throw new Error("Skill draft definition is malformed and cannot be edited."); }
  const candidate: TaughtSkillCandidate = {
    ...existing,
    name: edit.name,
    description: edit.description,
    purpose: edit.purpose,
    whenToUse: strings(edit.whenToUse),
    requiredContext: strings(edit.requiredContext),
    instructions: edit.instructions,
    outputContract: {
      ...existing.outputContract,
      format: edit.outputFormat,
      mustInclude: strings(edit.outputMustInclude),
      mustAvoid: strings(edit.outputMustAvoid),
    },
    // Never inherit or accept a client-controlled execution grant during review.
    execution: undefined,
  };
  const updated = await updateSkillDraft(userId, draftId, expectedRevision, candidate);
  await prisma.auditLog.create({ data: { userId, action: "skill.teaching.draft.updated", resourceType: "SkillDraft", resourceId: draftId, detail: `revision=${updated.revision}; safe_review_fields_only=true` } });
  return getTeachingDraftReview(userId, draftId);
}
