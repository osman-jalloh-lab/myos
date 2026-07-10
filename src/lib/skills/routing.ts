import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import {
  getRegisteredSkills,
  type SkillRegistryEntry,
} from "@/lib/skills/registry";
import {
  inferAgent,
  isBuildLikeRequest,
  isLocalWorkerDiagnosticRequest,
  MIN_CONFIDENCE,
  normalize,
  scoreRegisteredSkill,
  taskTypeFor,
  type SkillScoreResult,
} from "@/lib/skills/scoring";
import type { SkillOutputContract, SkillQualityBand } from "@/lib/skills/types";

const FALLBACK_OUTPUT_CONTRACT: SkillOutputContract = {
  format: "Concise guidance with safe next steps.",
  mustInclude: [],
  mustAvoid: [],
};

export type ResolvedSkill = {
  id: string;
  name: string;
  confidence: number;
  reason: string;
  safetyClass: SkillRegistryEntry["safetyClass"];
  ownerAgents: string[];
  tags: string[];
  estimatedCostSaving: SkillRegistryEntry["estimatedCostSaving"];
  instruction: string;
  role: "primary" | "supporting";
  skillQualityScore: number;
  skillQualityBand: SkillQualityBand;
  qualityWarnings: string[];
  purpose: string;
  matchedSignals: string[];
  negativeMatches: string[];
  missingContextQuestions: string[];
  outputContract: SkillOutputContract;
  safetyRules: string[];
  approvalRequiredFor: string[];
};

export type RejectedSkill = {
  id: string;
  score: number;
  reason: string;
};

export type SkillResolution = {
  matched: boolean;
  agentName: string | null;
  projectId: string | null;
  taskType: string;
  confidence: number;
  reason: string;
  skills: ResolvedSkill[];
  consideredSkillCount: number;
  primarySkill: ResolvedSkill | null;
  supportingSkills: ResolvedSkill[];
  rejectedSkills: RejectedSkill[];
  qualityWarnings: string[];
  missingContextQuestions: string[];
  explanation: string;
};

export type ResolveRelevantSkillsParams = {
  userId?: string;
  message: string;
  agentName?: string | null;
  projectId?: string | null;
  maxSkills?: number;
};

export type SkillUsageTelemetryInput = {
  userId: string;
  resolution: SkillResolution;
  modelCallAvoided?: boolean;
};

type ScoredSkill = SkillScoreResult & {
  skill: SkillRegistryEntry;
};

const SPECIFIC_PRIMARY_SKILLS = new Set([
  "i9-hr-compliance-specialist",
  "student-work-authorization-guard",
  "grc-risk-role-screener",
  "it-help-desk-trainer",
  "build-orchestrator",
  "local-worker-status",
  "project-starter",
  "repo-change-planner",
  "build-validation-runner",
]);

const BROAD_PRIMARY_SKILLS = new Set([
  "personal-context-anchor",
  "writing-humanizer",
  "job-application-ops",
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function oneLineList(items: string[], max = 3): string {
  return items.slice(0, max).join("; ");
}

function conciseInstruction(skill: SkillRegistryEntry, reason: string): string {
  const approval = skill.safetyClass === "read_only"
    ? "read-only guidance only"
    : "existing approval gates still apply before any durable action";
  const outputContract = skill.outputContract ?? FALLBACK_OUTPUT_CONTRACT;
  const output = outputContract.format ? ` Output: ${outputContract.format}` : "";
  return `Use ${skill.name} as local routing guidance: ${skill.purpose || skill.problemSolved} Safety: ${approval}.${output} Match reason: ${reason}`;
}

function toResolvedSkill(entry: ScoredSkill, role: ResolvedSkill["role"]): ResolvedSkill {
  const { skill, score, reason } = entry;
  const outputContract = skill.outputContract ?? FALLBACK_OUTPUT_CONTRACT;
  return {
    id: skill.id,
    name: skill.name,
    confidence: score,
    reason,
    safetyClass: skill.safetyClass,
    ownerAgents: skill.ownerAgents,
    tags: skill.tags,
    estimatedCostSaving: skill.estimatedCostSaving,
    instruction: conciseInstruction(skill, reason),
    role,
    skillQualityScore: skill.skillQualityScore ?? 0,
    skillQualityBand: skill.skillQualityBand ?? "Needs upgrade",
    qualityWarnings: skill.qualityWarnings ?? [],
    purpose: skill.purpose ?? skill.description,
    matchedSignals: entry.matchedSignals,
    negativeMatches: entry.negativeMatches,
    missingContextQuestions: entry.missingContextQuestions,
    outputContract,
    safetyRules: skill.safetyRules ?? [],
    approvalRequiredFor: skill.approvalRequiredFor ?? [],
  };
}

function wantsWritingSupport(message: string): boolean {
  return /draft|rewrite|humanize|less robotic|email|reply|message|tone|polish|text/i.test(message);
}

function isStudentAuthorizationText(text: string): boolean {
  return /\bf-?1\b|cpt|opt|stem opt|sponsorship|student work authorization|international office|on-campus|off-campus|work authorization/i.test(text);
}

function supportingPriority(primary: SkillRegistryEntry, candidate: SkillRegistryEntry, message: string): number {
  const text = normalize(message);
  if (candidate.id === primary.id) return 0;

  if (primary.id === "grc-risk-role-screener") {
    if (candidate.id === "job-application-ops") return 25;
    if (candidate.id === "personal-context-anchor") return 18;
    if (candidate.id === "writing-humanizer" && wantsWritingSupport(message)) return 10;
  }

  if (primary.id === "job-application-ops") {
    if (candidate.id === "personal-context-anchor") return 22;
    if (candidate.id === "student-work-authorization-guard" && isStudentAuthorizationText(text)) return 24;
    if (candidate.id === "writing-humanizer" && wantsWritingSupport(message)) return 12;
    if (candidate.id === "grc-risk-role-screener" && /\bgrc\b|soc 2|nist|risk management|compliance analyst/.test(text)) return 20;
  }

  if (primary.id === "student-work-authorization-guard") {
    if (candidate.id === "job-application-ops") return 22;
    if (candidate.id === "personal-context-anchor") return 18;
    if (candidate.id === "writing-humanizer" && wantsWritingSupport(message)) return 12;
  }

  if (primary.id === "i9-hr-compliance-specialist") {
    if (candidate.id === "writing-humanizer" && wantsWritingSupport(message)) return 16;
    if (candidate.id === "student-work-authorization-guard" && /\bf-?1\b|cpt|opt|student/.test(text)) return 14;
  }

  if (primary.id === "it-help-desk-trainer") {
    if (candidate.id === "writing-humanizer" && /customer|email|response|reply/.test(text)) return 16;
    if (candidate.id === "personal-context-anchor" && /interview|career|resume|my background/.test(text)) return 14;
  }

  if (primary.id === "writing-humanizer") {
    if (candidate.id === "i9-hr-compliance-specialist" && /\bi-?9\b|e-verify|employment eligibility/.test(text)) return 20;
    if (candidate.id === "student-work-authorization-guard" && isStudentAuthorizationText(text)) return 18;
    if (candidate.id === "job-application-ops" && /recruiter|resume|cover letter|application|job/.test(text)) return 16;
    if (candidate.id === "personal-context-anchor" && /my voice|my background|osman/.test(text)) return 14;
  }

  if (primary.id === "personal-context-anchor") {
    if (candidate.id === "job-application-ops" && /job|resume|role|recruiter|application/.test(text)) return 16;
    if (candidate.id === "writing-humanizer" && wantsWritingSupport(message)) return 12;
  }

  if (primary.id === "build-orchestrator") {
    if (candidate.id === "local-worker-status" && isLocalWorkerDiagnosticRequest(message)) return 28;
    if (candidate.id === "i9-hr-compliance-specialist" && /\bi-?9\b|e-verify|everify|employment eligibility/.test(text)) return 24;
    if (candidate.id === "personal-context-anchor" && /provider setup|model council|my os|hermes os|my repo|my app/.test(text)) return 10;
  }

  if (primary.id === "local-worker-status") {
    if (candidate.id === "build-orchestrator" && isBuildLikeRequest(message)) return 22;
    if (candidate.id === "build-validation-runner" && /run tests|run build|run typecheck|run lint|vercel status|safe to deploy|safe to push|validate/i.test(text)) return 18;
  }

  if (primary.id === "build-orchestrator") {
    if (candidate.id === "repo-change-planner" && /\bplan the files|files to inspect first|rollback plan|validation commands|plan code changes/i.test(text)) return 24;
    if (candidate.id === "build-validation-runner" && /run tests|run build|run typecheck|run lint|prisma generate|vercel status|safe to deploy|safe to push|validate/i.test(text)) return 20;
    if (candidate.id === "project-starter" && /start a project|scaffold this|new project|mvp|architecture|phases/i.test(text)) return 18;
  }

  if (primary.id === "project-starter") {
    if (candidate.id === "build-orchestrator" && /build|implement|fix|create|add|feature|route|api|component|page|ui|app/i.test(text)) return 22;
    if (candidate.id === "repo-change-planner" && /\bplan the files|files to inspect first|rollback plan|validation commands|plan code changes/i.test(text)) return 12;
  }

  if (primary.id === "repo-change-planner") {
    if (candidate.id === "build-orchestrator" && isBuildLikeRequest(message)) return 24;
    if (candidate.id === "build-validation-runner" && /run tests|run build|run typecheck|run lint|prisma generate|vercel status|safe to deploy|safe to push|validate/i.test(text)) return 18;
  }

  if (primary.id === "build-validation-runner") {
    if (candidate.id === "build-orchestrator" && isBuildLikeRequest(message)) return 20;
    if (candidate.id === "local-worker-status" && /local worker|ollama|queue not processing|worker offline|jobs stuck|not build/i.test(text)) return 18;
  }

  return 0;
}

function selectSupportingSkills(scored: ScoredSkill[], primary: ScoredSkill, message: string, slots: number): ScoredSkill[] {
  if (slots <= 0) return [];
  return scored
    .filter((entry) => entry.skill.id !== primary.skill.id)
    .map((entry) => ({
      ...entry,
      supportPriority: supportingPriority(primary.skill, entry.skill, message),
    }))
    .filter((entry) => entry.score >= 45 || (entry.supportPriority > 0 && entry.score >= 25))
    .sort((a, b) =>
      (b.supportPriority + b.score) - (a.supportPriority + a.score)
      || b.specificity - a.specificity
      || a.skill.name.localeCompare(b.skill.name)
    )
    .slice(0, slots);
}

function preferredPrimarySkillIds(message: string): string[] {
  const taskType = taskTypeFor(message);
  if (taskType === "local_worker_diagnostics") return ["local-worker-status"];
  if (taskType === "build_validation" || taskType === "deployment_status") return ["build-validation-runner"];
  if (taskType === "repo_change") return ["repo-change-planner"];
  if (taskType === "project_start") return ["project-starter"];
  if (taskType === "build") return ["build-orchestrator"];
  return [];
}

function selectPrimarySkill(scored: ScoredSkill[], message: string): ScoredSkill | null {
  for (const id of preferredPrimarySkillIds(message)) {
    const preferred = scored.find((entry) => entry.skill.id === id && entry.score >= MIN_CONFIDENCE);
    if (preferred) return preferred;
  }

  const best = scored.find((entry) => entry.score >= MIN_CONFIDENCE) ?? null;
  if (!best) return null;
  if (!BROAD_PRIMARY_SKILLS.has(best.skill.id)) return best;
  const specific = scored.find((entry) =>
    SPECIFIC_PRIMARY_SKILLS.has(entry.skill.id)
    && entry.score >= 75
    && entry.score >= best.score - 15
  );
  return specific ?? best;
}

function qualityWarningsFor(skills: ResolvedSkill[]): string[] {
  return skills.flatMap((skill) => {
    if (skill.skillQualityScore >= 75) return [];
    return [`${skill.name} quality is ${skill.skillQualityScore}/100 (${skill.skillQualityBand}). ${skill.qualityWarnings.slice(0, 2).join(" ")}`];
  });
}

function buildLikeNoMatchReason(message: string): string | null {
  return isBuildLikeRequest(message)
    ? "Build-like request detected, but no builder skill matched. Check build-orchestrator registration and local worker status."
    : null;
}

function buildExplanation(primary: ResolvedSkill | null, supporting: ResolvedSkill[], rejected: RejectedSkill[], consideredCount: number, message: string): string {
  if (!primary) {
    const buildLike = buildLikeNoMatchReason(message);
    if (buildLike) return buildLike;
    const best = rejected[0];
    return best
      ? `No skill crossed the confidence threshold. Best candidate was ${best.id} at ${best.score}/100 because ${best.reason}`
      : `No enabled skill was available to score. Considered ${consideredCount} skills.`;
  }
  const supportText = supporting.length
    ? ` Supporting skills: ${supporting.map((skill) => `${skill.id} (${skill.confidence}%)`).join(", ")}.`
    : "";
  return `Primary skill ${primary.id} matched at ${primary.confidence}/100 because ${primary.reason}.${supportText}`;
}

export function formatSkillsUsed(resolution: SkillResolution): string {
  if (!resolution.matched || !resolution.primarySkill) {
    const buildLike = /^Build-like request detected/i.test(resolution.reason) ? ` ${resolution.reason}` : "";
    return `Skills used: none matched (${resolution.confidence}% confidence).${buildLike} Normal agent/model path used.`;
  }
  const supporting = resolution.supportingSkills.length
    ? ` Supporting: ${resolution.supportingSkills.map((skill) => `${skill.id} (${skill.confidence}%)`).join(", ")}.`
    : "";
  return `Skills used: primary ${resolution.primarySkill.id} (${resolution.primarySkill.confidence}%).${supporting}`;
}

export function skillInstructionBlock(resolution: SkillResolution): string | null {
  if (!resolution.matched || !resolution.primarySkill) return null;
  const primary = resolution.primarySkill;
  const supporting = resolution.supportingSkills.slice(0, 3);
  const lines = [
    "SKILL-FIRST ROUTING",
    "Use matched skills as concise guidance only. Do not bypass ApprovalAction requirements, durable-memory approval, auth checks, or external-system safety gates.",
    "",
    `Primary skill: ${primary.name} (${primary.confidence}% confidence, ${primary.skillQualityScore}/100 quality)`,
    `Why it matched: ${primary.reason}`,
    `Use for: ${oneLineList(primary.matchedSignals.length ? primary.matchedSignals : primary.tags, 4) || primary.purpose}`,
  ];

  if (supporting.length) {
    lines.push("", "Supporting skills:");
    for (const skill of supporting) {
      lines.push(`- ${skill.name} (${skill.confidence}%): ${skill.reason.slice(0, 180)}`);
    }
  }

  const safety = unique([...primary.safetyRules, ...supporting.flatMap((skill) => skill.safetyRules)]).slice(0, 6);
  if (safety.length) {
    lines.push("", "Required behavior:");
    lines.push(...safety.map((rule) => `- ${rule}`));
  }

  const approvals = unique([...primary.approvalRequiredFor, ...supporting.flatMap((skill) => skill.approvalRequiredFor)]).slice(0, 5);
  if (approvals.length) {
    lines.push("", `Approval required for: ${approvals.join("; ")}.`);
  }

  const questions = resolution.missingContextQuestions.slice(0, 4);
  if (questions.length) {
    lines.push("", "Missing context to ask or flag:");
    lines.push(...questions.map((question) => `- ${question}`));
  }

  lines.push("", `Output format: ${primary.outputContract.format}`);
  if (primary.outputContract.mustInclude.length) lines.push(`Must include: ${primary.outputContract.mustInclude.slice(0, 5).join("; ")}.`);
  if (primary.outputContract.mustAvoid.length) lines.push(`Must avoid: ${primary.outputContract.mustAvoid.slice(0, 5).join("; ")}.`);

  return lines.join("\n");
}

export async function resolveRelevantSkills({
  userId = "system",
  message,
  agentName,
  projectId = null,
  maxSkills = 4,
}: ResolveRelevantSkillsParams): Promise<SkillResolution> {
  const inferredAgent = inferAgent(message, agentName);
  const limit = Math.max(1, Math.min(5, maxSkills || 4));
  const skills = await getRegisteredSkills(userId);
  const candidates = skills.filter((skill) => skill.enabled && skill.validationStatus !== "invalid");
  const scored = candidates
    .map((skill) => ({ skill, ...scoreRegisteredSkill(skill, message, inferredAgent) }))
    .sort((a, b) =>
      b.score - a.score
      || b.specificity - a.specificity
      || (b.skill.skillQualityScore ?? 0) - (a.skill.skillQualityScore ?? 0)
      || a.skill.name.localeCompare(b.skill.name)
    );

  const primaryScored = selectPrimarySkill(scored, message);
  const supportingScored = primaryScored ? selectSupportingSkills(scored, primaryScored, message, limit - 1) : [];
  const primarySkill = primaryScored ? toResolvedSkill(primaryScored, "primary") : null;
  const supportingSkills = supportingScored.map((entry) => toResolvedSkill(entry, "supporting"));
  const selectedIds = new Set([primarySkill?.id, ...supportingSkills.map((skill) => skill.id)].filter(Boolean));
  const rejectedSkills = scored
    .filter((entry) => !selectedIds.has(entry.skill.id))
    .slice(0, 8)
    .map((entry) => ({
      id: entry.skill.id,
      score: entry.score,
      reason: entry.reason,
    }));
  const resolvedSkills = primarySkill ? [primarySkill, ...supportingSkills] : [];
  const missingContextQuestions = unique(resolvedSkills.flatMap((skill) => skill.missingContextQuestions)).slice(0, 6);
  const qualityWarnings = qualityWarningsFor(resolvedSkills);
  const topScore = scored[0]?.score ?? 0;
  const taskType = taskTypeFor(message);
  const explanation = buildExplanation(primarySkill, supportingSkills, rejectedSkills, candidates.length, message);
  const noMatchReason = primarySkill
    ? primarySkill.reason
    : buildLikeNoMatchReason(message) ?? "No enabled skill matched this message strongly enough.";

  return {
    matched: Boolean(primarySkill),
    agentName: inferredAgent,
    projectId,
    taskType,
    confidence: primarySkill?.confidence ?? topScore,
    reason: noMatchReason,
    consideredSkillCount: candidates.length,
    skills: resolvedSkills,
    primarySkill,
    supportingSkills,
    rejectedSkills,
    qualityWarnings,
    missingContextQuestions,
    explanation,
  };
}

async function ensureSkillRoutingTelemetryTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS SkillUsageTelemetry (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      skillId TEXT NOT NULL,
      skillName TEXT NOT NULL,
      agentName TEXT,
      projectId TEXT,
      taskType TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      modelCallAvoided INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS SkillUsageTelemetry_userId_createdAt_idx ON SkillUsageTelemetry(userId, createdAt)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS SkillUsageTelemetry_skillId_createdAt_idx ON SkillUsageTelemetry(skillId, createdAt)`);
}

async function markSkillUsed(userId: string, skillId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS SkillRegistryState (
      userId TEXT NOT NULL,
      skillId TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastUsedAt TEXT,
      usageCount INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, skillId)
    )
  `);
  await prisma.$executeRawUnsafe(
    `INSERT INTO SkillRegistryState (userId, skillId, enabled, lastUsedAt, usageCount, updatedAt)
     VALUES (?, ?, 1, datetime('now'), 1, datetime('now'))
     ON CONFLICT(userId, skillId) DO UPDATE SET lastUsedAt = datetime('now'), usageCount = usageCount + 1, updatedAt = datetime('now')`,
    userId,
    skillId,
  );
}

export async function recordSkillUsageTelemetry({
  userId,
  resolution,
  modelCallAvoided = false,
}: SkillUsageTelemetryInput): Promise<void> {
  await ensureSkillRoutingTelemetryTable();
  const rows = resolution.matched
    ? resolution.skills.map((skill) => ({
        skillId: skill.id,
        skillName: skill.name,
        confidence: skill.confidence,
        reason: skill.reason,
      }))
    : [{
        skillId: "none",
        skillName: "No skill matched",
        confidence: resolution.confidence,
        reason: resolution.reason,
      }];

  for (const row of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO SkillUsageTelemetry
       (id, userId, skillId, skillName, agentName, projectId, taskType, confidence, reason, modelCallAvoided, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      crypto.randomUUID(),
      userId,
      row.skillId,
      row.skillName,
      resolution.agentName,
      resolution.projectId,
      resolution.taskType,
      row.confidence,
      row.reason.slice(0, 1000),
      modelCallAvoided ? 1 : 0,
    );
    if (row.skillId !== "none") await markSkillUsed(userId, row.skillId);
  }
}
