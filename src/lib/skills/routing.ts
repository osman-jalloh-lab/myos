import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getRegisteredSkills, type SkillRegistryEntry } from "@/lib/skills/registry";

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

const MIN_CONFIDENCE = 35;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "from", "into",
  "about", "what", "when", "where", "should", "could", "would", "need", "help", "please",
  "make", "does", "have", "has", "will", "just", "give", "tell", "show", "using",
]);

const DOMAIN_ALIASES: Record<string, string[]> = {
  "i9-hr-compliance-specialist": [
    "i-9", "i9", "e-verify", "everify", "work authorization", "employment eligibility",
    "m-274", "section 2", "section 3", "reverification", "hr compliance", "onboarding",
  ],
  "student-work-authorization-guard": [
    "student worker", "work authorization", "visa", "f-1", "cpt", "opt", "student employment",
  ],
  "job-application-ops": [
    "job application", "resume", "cover letter", "ats", "interview", "recruiter", "application tracker",
  ],
  "grc-risk-role-screener": [
    "grc", "risk management", "security+", "cysa+", "soc", "security operations", "compliance analyst",
  ],
  "it-help-desk-trainer": [
    "help desk", "service desk", "ticket", "troubleshoot", "technical support", "active directory",
  ],
  "writing-humanizer": [
    "rewrite", "humanize", "tone", "sound natural", "draft", "polish", "writing",
  ],
  "personal-context-anchor": [
    "personal context", "my background", "my preferences", "remembered context", "osman",
  ],
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+.#-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 80);
}

function includesPhrase(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 2 && haystack.includes(needle);
}

function taskTypeFor(message: string): string {
  const text = normalize(message);
  if (/\bi-?9\b|e-verify|employment eligibility|work authorization|hr compliance/.test(text)) return "hr_compliance";
  if (/resume|cover letter|interview|job application|ats|recruiter|grc|soc|risk management/.test(text)) return "career";
  if (/email|inbox|reply|draft/.test(text)) return "communications";
  if (/calendar|meeting|schedule|deadline|appointment/.test(text)) return "scheduling";
  if (/build|app|site|frontend|component|feature/.test(text)) return "build";
  return "general";
}

function inferAgent(message: string, explicitAgent?: string | null): string | null {
  if (explicitAgent) return explicitAgent;
  const type = taskTypeFor(message);
  if (type === "hr_compliance") return "themis";
  if (type === "career") return "athena";
  if (type === "communications") return "iris";
  if (type === "scheduling") return "kairos";
  if (type === "build") return "prometheus";
  return "hermes";
}

function agentMatches(skill: SkillRegistryEntry, agentName: string | null): boolean {
  if (!agentName) return false;
  const agent = agentName.toLowerCase();
  return skill.ownerAgents.some((owner) => owner.toLowerCase() === agent || owner.toLowerCase() === "hermes");
}

function scoreSkill(skill: SkillRegistryEntry, message: string, agentName: string | null): { score: number; reason: string } {
  const text = normalize(message);
  const words = tokens(message);
  const reasons: string[] = [];
  let score = 0;

  if (agentMatches(skill, agentName)) {
    const exact = skill.ownerAgents.some((owner) => owner.toLowerCase() === agentName?.toLowerCase());
    score += exact ? 18 : 8;
    reasons.push(exact ? `owned by ${agentName}` : "available to Hermes");
  }

  const aliases = DOMAIN_ALIASES[skill.id] ?? [];
  const aliasHits = aliases.filter((alias) => includesPhrase(text, alias)).slice(0, 4);
  if (aliasHits.length) {
    score += aliasHits.length * 18;
    reasons.push(`matched domain terms: ${aliasHits.join(", ")}`);
  }

  const tagHits = skill.tags.filter((tag) => includesPhrase(text, tag)).slice(0, 4);
  if (tagHits.length) {
    score += tagHits.length * 12;
    reasons.push(`matched tags: ${tagHits.join(", ")}`);
  }

  const triggerHits = skill.triggerExamples.filter((example) => {
    const exampleWords = tokens(example);
    if (exampleWords.length === 0) return false;
    const overlap = exampleWords.filter((word) => words.includes(word)).length;
    return overlap >= Math.min(2, exampleWords.length);
  }).slice(0, 3);
  if (triggerHits.length) {
    score += triggerHits.length * 16;
    reasons.push(`matched trigger examples`);
  }

  const metadata = normalize([
    skill.name,
    skill.description,
    skill.problemSolved,
    ...skill.requiredCapabilities,
  ].join(" "));
  const metadataHits = words.filter((word) => metadata.includes(word)).slice(0, 8);
  if (metadataHits.length) {
    score += Math.min(24, metadataHits.length * 4);
    reasons.push(`matched metadata words: ${metadataHits.slice(0, 5).join(", ")}`);
  }

  if (skill.validationStatus === "missing_metadata") score -= 8;
  if (skill.validationStatus === "invalid") score -= 30;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reason: reasons.length ? reasons.join("; ") : "No deterministic metadata match above the routing threshold.",
  };
}

function conciseInstruction(skill: SkillRegistryEntry, reason: string): string {
  const approval = skill.safetyClass === "read_only"
    ? "read-only guidance only"
    : "existing approval gates still apply before any durable action";
  return `Use ${skill.name} only as concise local guidance: ${skill.problemSolved} Safety: ${approval}. Match reason: ${reason}`;
}

export function formatSkillsUsed(resolution: SkillResolution): string {
  if (!resolution.matched) {
    return `Skills used: none matched (${resolution.confidence}% confidence). Normal agent/model path used.`;
  }
  const skills = resolution.skills
    .map((skill) => `${skill.id} (${skill.confidence}%)`)
    .join(", ");
  return `Skills used: ${skills}.`;
}

export function skillInstructionBlock(resolution: SkillResolution): string | null {
  if (!resolution.matched) return null;
  const lines = resolution.skills.map((skill) => `- ${skill.instruction}`);
  return [
    "SKILL-FIRST ROUTING",
    "Use these matched skills as concise guidance only. Do not bypass ApprovalAction requirements, durable-memory approval, or system safety rules.",
    ...lines,
  ].join("\n");
}

export async function resolveRelevantSkills({
  userId = "system",
  message,
  agentName,
  projectId = null,
  maxSkills = 3,
}: ResolveRelevantSkillsParams): Promise<SkillResolution> {
  const inferredAgent = inferAgent(message, agentName);
  const limit = Math.max(1, Math.min(3, maxSkills || 3));
  const skills = await getRegisteredSkills(userId);
  const candidates = skills.filter((skill) => skill.enabled && skill.validationStatus !== "invalid");
  const scored = candidates
    .map((skill) => ({ skill, ...scoreSkill(skill, message, inferredAgent) }))
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  const selected = scored.filter((entry) => entry.score >= MIN_CONFIDENCE).slice(0, limit);
  const topScore = scored[0]?.score ?? 0;

  return {
    matched: selected.length > 0,
    agentName: inferredAgent,
    projectId,
    taskType: taskTypeFor(message),
    confidence: selected[0]?.score ?? topScore,
    reason: selected[0]?.reason ?? "No enabled skill matched this message strongly enough.",
    consideredSkillCount: candidates.length,
    skills: selected.map(({ skill, score, reason }) => ({
      id: skill.id,
      name: skill.name,
      confidence: score,
      reason,
      safetyClass: skill.safetyClass,
      ownerAgents: skill.ownerAgents,
      tags: skill.tags,
      estimatedCostSaving: skill.estimatedCostSaving,
      instruction: conciseInstruction(skill, reason),
    })),
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
