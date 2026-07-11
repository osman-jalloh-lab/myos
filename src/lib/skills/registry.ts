import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { resolveLocalProjectsRoot } from "@/lib/local-projects-root";
import { calculateSkillQualityScore, DEFAULT_OUTPUT_CONTRACT } from "@/lib/skills/quality";
import { inferAgent, MIN_CONFIDENCE, scoreRegisteredSkill } from "@/lib/skills/scoring";
import type { SkillEvaluationPrompt, SkillOutputContract, SkillQualityBand } from "@/lib/skills/types";

export type RegisteredSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  ownerAgents: string[];
  tags: string[];
  triggerExamples: string[];
  requiredCapabilities: string[];
  safetyClass: "read_only" | "approval_required" | "local_execution";
  estimatedCostSaving: "none" | "low" | "medium" | "high";
  lastUsedAt: string | null;
  usageCount: number;
  source: "built_in" | "installed" | "scouted" | "user";
  validationStatus: "valid" | "missing_metadata" | "invalid";
  executionTool: string | null;
  executionRisk: "read" | "internal_write" | "external_write" | null;
  executionRequiresApproval: boolean;
};

export type SkillRegistryEntry = RegisteredSkill & {
  category: string;
  dateAdded: string | null;
  validationWarnings: string[];
  problemSolved: string;
  instructionFile: string | null;
  instructionPreview: string | null;
  purpose: string;
  whenToUse: string[];
  whenNotToUse: string[];
  strongSignals: string[];
  weakSignals: string[];
  negativeSignals: string[];
  requiredContext: string[];
  missingContextQuestions: string[];
  outputContract: SkillOutputContract;
  safetyRules: string[];
  approvalRequiredFor: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  evaluationPrompts: SkillEvaluationPrompt[];
  version: string;
  lastReviewedAt: string | null;
  skillQualityScore: number;
  skillQualityBand: SkillQualityBand;
  qualityWarnings: string[];
};

export type SkillMatchResult = {
  skillId: string;
  matched: boolean;
  score: number;
  reason: string;
  matchedSignals: string[];
  negativeMatches: string[];
  missingContextQuestions: string[];
  skillQualityScore: number;
  skillQualityBand: SkillQualityBand;
};

type SkillStateRow = {
  skillId: string;
  enabled: boolean | number;
  lastUsedAt: Date | string | null;
  usageCount: number | bigint | null;
};

type UserSkillRow = {
  skillId: string;
  name: string;
  description: string;
  category: string | null;
  definition: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PlannerSkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  tool: string;
  risk: "read" | "internal_write" | "external_write";
  requiresApproval: boolean;
  triggers: string[];
};

let cache: { createdAt: number; entries: SkillRegistryEntry[] } | null = null;
let skillStateTableEnsured = false;
let skillStateTableEnsurePromise: Promise<void> | null = null;
const CACHE_MS = 60_000;

export const PERSONAL_SKILL_IDS = [
  "personal-context-anchor",
  "i9-hr-compliance-specialist",
  "job-application-ops",
  "it-help-desk-trainer",
  "grc-risk-role-screener",
  "student-work-authorization-guard",
  "writing-humanizer",
] as const;

const PERSONAL_SKILL_ID_SET = new Set<string>(PERSONAL_SKILL_IDS);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "skill";
}

function splitYamlPair(line: string): { key: string; raw: string } | null {
  const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  return pair ? { key: pair[1], raw: pair[2] } : null;
}

function parseYamlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const unquoted = trimmed.replace(/^["']|["']$/g, "");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  if ((unquoted.startsWith("[") && unquoted.endsWith("]")) || (unquoted.startsWith("{") && unquoted.endsWith("}"))) {
    try {
      return JSON.parse(unquoted);
    } catch {
      return unquoted;
    }
  }
  return unquoted;
}

function parseFrontMatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1]
    .split(/\r?\n/)
    .map((raw) => ({
      indent: raw.match(/^\s*/)?.[0].length ?? 0,
      text: raw.trim(),
    }))
    .filter((line) => line.text && !line.text.startsWith("#"));

  function parseObject(start: number, indent: number): { value: Record<string, unknown>; index: number } {
    const value: Record<string, unknown> = {};
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        index++;
        continue;
      }
      if (line.text.startsWith("- ")) break;
      const pair = splitYamlPair(line.text);
      if (!pair) {
        index++;
        continue;
      }
      if (pair.raw.trim()) {
        value[pair.key] = parseYamlScalar(pair.raw);
        index++;
        continue;
      }
      const next = lines[index + 1];
      if (!next || next.indent <= line.indent) {
        value[pair.key] = [];
        index++;
        continue;
      }
      const parsed = next.text.startsWith("- ")
        ? parseArray(index + 1, next.indent)
        : parseObject(index + 1, next.indent);
      value[pair.key] = parsed.value;
      index = parsed.index;
    }
    return { value, index };
  }

  function parseArray(start: number, indent: number): { value: unknown[]; index: number } {
    const value: unknown[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent || !line.text.startsWith("- ")) break;
      if (line.indent > indent) {
        index++;
        continue;
      }
      const rest = line.text.slice(2).trim();
      const inlinePair = splitYamlPair(rest);
      if (inlinePair) {
        const item: Record<string, unknown> = {};
        item[inlinePair.key] = inlinePair.raw.trim() ? parseYamlScalar(inlinePair.raw) : "";
        index++;
        if (index < lines.length && lines[index].indent > indent) {
          const parsed = parseObject(index, lines[index].indent);
          Object.assign(item, parsed.value);
          index = parsed.index;
        }
        value.push(item);
        continue;
      }
      if (rest) {
        value.push(parseYamlScalar(rest));
        index++;
        continue;
      }
      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        value.push("");
        index++;
        continue;
      }
      const parsed = next.text.startsWith("- ")
        ? parseArray(index + 1, next.indent)
        : parseObject(index + 1, next.indent);
      value.push(parsed.value);
      index = parsed.index;
    }
    return { value, index };
  }

  return parseObject(0, 0).value;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown, max = 60): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean).slice(0, max);
  const text = asString(value);
  return text ? [text] : [];
}

function asOutputContract(value: unknown): SkillOutputContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_OUTPUT_CONTRACT;
  const raw = value as Record<string, unknown>;
  return {
    format: asString(raw.format) || DEFAULT_OUTPUT_CONTRACT.format,
    mustInclude: asStringArray(raw.mustInclude),
    mustAvoid: asStringArray(raw.mustAvoid),
    tone: asString(raw.tone) || undefined,
  };
}

function asEvaluationPrompts(value: unknown): SkillEvaluationPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const input = asString(raw.input);
    const reason = asString(raw.reason);
    if (!input || !reason || typeof raw.shouldMatch !== "boolean") return [];
    const prompt: SkillEvaluationPrompt = {
      input,
      shouldMatch: raw.shouldMatch,
      reason,
    };
    const minimumScore = typeof raw.minimumScore === "number" ? raw.minimumScore : undefined;
    const expectedSkill = asString(raw.expectedSkill) || undefined;
    if (minimumScore !== undefined) prompt.minimumScore = minimumScore;
    if (expectedSkill) prompt.expectedSkill = expectedSkill;
    return [prompt];
  });
}

function executionRiskFrom(value: unknown): RegisteredSkill["executionRisk"] {
  const text = asString(value).toLowerCase();
  if (text === "read" || text === "internal_write" || text === "external_write") return text;
  return null;
}

function safetyClassFrom(value: unknown, requiresApproval?: boolean): RegisteredSkill["safetyClass"] {
  const text = asString(value).toLowerCase();
  if (text === "local_execution") return "local_execution";
  if (text === "approval_required" || text === "external_write" || requiresApproval) return "approval_required";
  return "read_only";
}

function costSavingFor(tags: string[], description: string, source: RegisteredSkill["source"]): RegisteredSkill["estimatedCostSaving"] {
  const text = `${tags.join(" ")} ${description}`.toLowerCase();
  if (/routing|triage|draft|brief|context|screen|guard|compliance|trainer|humanizer/.test(text)) return "medium";
  if (source === "scouted") return "low";
  return "none";
}

function problemSolved(skill: Pick<RegisteredSkill, "name" | "description" | "ownerAgents" | "tags">): string {
  const agent = skill.ownerAgents[0] ? skill.ownerAgents[0][0].toUpperCase() + skill.ownerAgents[0].slice(1) : "Hermes";
  const plain = skill.description.replace(/\.$/, "");
  if (/brief|context|ground/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} turn rough context into a grounded response before an expensive model call.`;
  if (/job|resume|application|role|risk|grc|soc/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} screen career opportunities against Osman's real goals before drafting or outreach.`;
  if (/write|human|tone/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} make drafts sound more direct and human before they leave the system.`;
  return plain || `This skill gives ${agent} reusable instructions for a recurring workflow.`;
}

function validationStatus(meta: Record<string, unknown>, hasJson: boolean, hasSkillMd: boolean): Pick<SkillRegistryEntry, "validationStatus" | "validationWarnings"> {
  const warnings: string[] = [];
  if (!hasJson && !hasSkillMd) warnings.push("No safe metadata file found.");
  if (!asString(meta.name)) warnings.push("Missing name.");
  if (!asString(meta.description)) warnings.push("Missing description.");
  const execution = meta.execution as { risk?: unknown } | undefined;
  if (!asString(meta.safetyClass) && !asString(execution?.risk)) warnings.push("Missing safety class; defaulted to read-only.");
  if (!hasSkillMd) warnings.push("Missing SKILL.md instructions.");
  if (warnings.some((warning) => warning.startsWith("Missing name") || warning.startsWith("No safe"))) return { validationStatus: "invalid", validationWarnings: warnings };
  if (warnings.length) return { validationStatus: "missing_metadata", validationWarnings: warnings };
  return { validationStatus: "valid", validationWarnings: [] };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readSkillMd(filePath: string): Promise<{ meta: Record<string, unknown>; preview: string | null } | null> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (!content) return null;
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
  return {
    meta: parseFrontMatter(content),
    preview: body.slice(0, 3600),
  };
}

function buildRegistryEntry({
  id,
  meta,
  source,
  pathValue,
  instructionFile,
  instructionPreview,
  dateAdded,
  hasJson,
  hasSkillMd,
}: {
  id: string;
  meta: Record<string, unknown>;
  source: RegisteredSkill["source"];
  pathValue: string;
  instructionFile: string | null;
  instructionPreview: string | null;
  dateAdded: string | null;
  hasJson: boolean;
  hasSkillMd: boolean;
}): SkillRegistryEntry {
  const execution = meta.execution as { tool?: unknown; risk?: unknown; requiresApproval?: unknown; pipeline?: unknown } | undefined;
  const name = asString(meta.name) || id;
  const description = asString(meta.description) || "Local skill instructions.";
  const ownerAgents = asStringArray(meta.ownerAgents).length ? asStringArray(meta.ownerAgents) : [asString(meta.agent) || "hermes"];
  const tags = asStringArray(meta.tags).length ? asStringArray(meta.tags) : [asString(meta.category)].filter(Boolean);
  const positiveExamples = asStringArray(meta.positiveExamples);
  const triggerExamplesBase = asStringArray(meta.triggerExamples).length ? asStringArray(meta.triggerExamples) : asStringArray(meta.examples);
  const triggerExamples = [...new Set([...triggerExamplesBase, ...positiveExamples.slice(0, 8), ...asStringArray(meta.whenToUse).slice(0, 6)])];
  const requiredCapabilities = asStringArray(meta.requiredCapabilities).length
    ? asStringArray(meta.requiredCapabilities)
    : asStringArray(execution?.pipeline);
  const safetyClass = safetyClassFrom(meta.safetyClass ?? execution?.risk, Boolean(execution?.requiresApproval));
  const executionRisk = executionRiskFrom(execution?.risk);
  const validation = validationStatus(meta, hasJson, hasSkillMd);
  const category = asString(meta.category) || tags[0] || "workflow";
  const outputContract = asOutputContract(meta.outputContract);
  const entryBase = {
    id,
    name,
    description,
    path: pathValue,
    enabled: true,
    ownerAgents,
    tags,
    triggerExamples,
    requiredCapabilities,
    safetyClass,
    estimatedCostSaving: costSavingFor(tags, description, source),
    lastUsedAt: null,
    usageCount: 0,
    source,
    validationStatus: validation.validationStatus,
    executionTool: asString(execution?.tool) || null,
    executionRisk,
    executionRequiresApproval: Boolean(execution?.requiresApproval),
    category,
    dateAdded,
    validationWarnings: validation.validationWarnings,
    problemSolved: problemSolved({ name, description, ownerAgents, tags }),
    instructionFile,
    instructionPreview,
    purpose: asString(meta.purpose) || description,
    whenToUse: asStringArray(meta.whenToUse),
    whenNotToUse: asStringArray(meta.whenNotToUse),
    strongSignals: asStringArray(meta.strongSignals),
    weakSignals: asStringArray(meta.weakSignals),
    negativeSignals: asStringArray(meta.negativeSignals),
    requiredContext: asStringArray(meta.requiredContext),
    missingContextQuestions: asStringArray(meta.missingContextQuestions),
    outputContract,
    safetyRules: asStringArray(meta.safetyRules),
    approvalRequiredFor: asStringArray(meta.approvalRequiredFor),
    positiveExamples,
    negativeExamples: asStringArray(meta.negativeExamples),
    evaluationPrompts: asEvaluationPrompts(meta.evaluationPrompts),
    version: asString(meta.version) || "1.0.0",
    lastReviewedAt: asString(meta.lastReviewedAt) || null,
  };
  const quality = calculateSkillQualityScore({
    ...entryBase,
    lastReviewedAt: entryBase.lastReviewedAt ?? undefined,
  });
  return {
    ...entryBase,
    skillQualityScore: quality.score,
    skillQualityBand: quality.band,
    qualityWarnings: quality.warnings,
  };
}

async function scanRepoSkills(): Promise<SkillRegistryEntry[]> {
  const root = path.join(process.cwd(), "skills");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith("_")) names.add(entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) names.add(entry.name.replace(/\.json$/i, ""));
  }

  const skills: SkillRegistryEntry[] = [];
  for (const id of names) {
    const dir = path.join(root, id);
    const jsonPath = path.join(root, `${id}.json`);
    const json = await readJson(jsonPath);
    const skillMd = await readSkillMd(path.join(dir, "SKILL.md"));
    const meta = { ...(json ?? {}), ...(skillMd?.meta ?? {}) };
    const info = await stat(json ? jsonPath : dir).catch(() => null);
    const source: RegisteredSkill["source"] = id.startsWith("skill-scout-") ? "scouted" : PERSONAL_SKILL_ID_SET.has(id) ? "installed" : "built_in";
    skills.push(buildRegistryEntry({
      id,
      meta,
      source,
      pathValue: json ? jsonPath : dir,
      instructionFile: skillMd ? path.join(dir, "SKILL.md") : null,
      instructionPreview: skillMd?.preview ?? null,
      dateAdded: info?.birthtime?.toISOString() ?? null,
      hasJson: Boolean(json),
      hasSkillMd: Boolean(skillMd),
    }));
  }
  return skills;
}

async function scanFolderSkills(root: string, sourceLabel: string): Promise<SkillRegistryEntry[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(async (entry) => {
    const dir = path.join(root, entry.name);
    const skillMd = await readSkillMd(path.join(dir, "SKILL.md"));
    const meta = skillMd?.meta ?? {};
    const info = await stat(dir).catch(() => null);
    return buildRegistryEntry({
      id: `${sourceLabel}:${entry.name}`,
      meta,
      source: "installed",
      pathValue: dir,
      instructionFile: skillMd ? path.join(dir, "SKILL.md") : null,
      instructionPreview: skillMd?.preview ?? null,
      dateAdded: info?.birthtime?.toISOString() ?? null,
      hasJson: false,
      hasSkillMd: Boolean(skillMd),
    });
  }));
}

async function scanUserSkills(userId: string): Promise<SkillRegistryEntry[]> {
  const client = prisma as typeof prisma & {
    userSkill?: {
      findMany: (args: unknown) => Promise<UserSkillRow[]>;
    };
  };
  if (!client.userSkill?.findMany) return [];

  const rows = await client.userSkill.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  }).catch(() => []);

  return rows.flatMap((row) => {
    let definition: unknown;
    try {
      definition = JSON.parse(row.definition);
    } catch {
      return [];
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
    const raw = definition as Record<string, unknown>;
    const meta = {
      ...raw,
      id: row.skillId,
      name: row.name,
      description: row.description,
      category: row.category ?? (asString(raw.category) || "workflow"),
    };
    const instructions = asString(raw.instructions) || asString(raw.body) || null;
    const entry = buildRegistryEntry({
      id: row.skillId,
      meta,
      source: "user",
      pathValue: `db:user-skill:${row.skillId}`,
      instructionFile: null,
      instructionPreview: instructions,
      dateAdded: new Date(row.createdAt).toISOString(),
      hasJson: true,
      hasSkillMd: true,
    });
    return [{ ...entry, enabled: Boolean(row.enabled) }];
  });
}

async function ensureSkillStateTable(): Promise<void> {
  if (skillStateTableEnsured) return;
  if (!skillStateTableEnsurePromise) {
    skillStateTableEnsurePromise = prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS SkillRegistryState (
        userId TEXT NOT NULL,
        skillId TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        lastUsedAt TEXT,
        usageCount INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (userId, skillId)
      )
    `).then(() => {
      skillStateTableEnsured = true;
    }).catch((error) => {
      skillStateTableEnsurePromise = null;
      throw error;
    });
  }
  await skillStateTableEnsurePromise;
}

async function stateBySkill(userId: string): Promise<Map<string, SkillStateRow>> {
  await ensureSkillStateTable();
  const rows = await prisma.$queryRawUnsafe<SkillStateRow[]>(`SELECT skillId, enabled, lastUsedAt, usageCount FROM SkillRegistryState WHERE userId = ?`, userId).catch(() => []);
  return new Map(rows.map((row) => [row.skillId, row]));
}

export function clearSkillRegistryCache(): void {
  cache = null;
}

export async function getRegisteredSkills(userId: string, refresh = false): Promise<SkillRegistryEntry[]> {
  if (refresh) clearSkillRegistryCache();
  if (!cache || Date.now() - cache.createdAt > CACHE_MS) {
    const projectsRoot = resolveLocalProjectsRoot();
    const [repo, agent, local, user] = await Promise.all([
      scanRepoSkills(),
      scanFolderSkills(path.join(os.homedir(), ".agents", "skills"), "agent"),
      scanFolderSkills(path.join(projectsRoot, "skills"), "local"),
      scanUserSkills(userId),
    ]);
    const byId = new Map<string, SkillRegistryEntry>();
    for (const skill of [...repo, ...agent, ...local, ...user]) if (!byId.has(skill.id)) byId.set(skill.id, skill);
    cache = { createdAt: Date.now(), entries: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }
  const state = await stateBySkill(userId);
  return cache.entries.map((skill) => {
    const row = state.get(skill.id);
    return {
      ...skill,
      enabled: row ? Boolean(Number(row.enabled)) : skill.enabled,
      lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : skill.lastUsedAt,
      usageCount: row?.usageCount ? Number(row.usageCount) : skill.usageCount,
    };
  });
}

export async function getPlannerSkillCatalog(userId: string): Promise<PlannerSkillCatalogEntry[]> {
  const skills = await getRegisteredSkills(userId);
  return skills.flatMap((skill) => {
    if (!skill.enabled || !skill.executionTool) return [];
    const risk = skill.executionRisk ?? (skill.safetyClass === "approval_required" ? "external_write" : "read");
    return [{
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tool: skill.executionTool,
      risk,
      requiresApproval: skill.executionRequiresApproval || skill.safetyClass === "approval_required" || risk === "external_write",
      triggers: [...skill.triggerExamples, ...skill.strongSignals, ...skill.whenToUse].slice(0, 8),
    }];
  });
}

export async function setSkillEnabled(userId: string, skillId: string, enabled: boolean): Promise<SkillRegistryEntry | null> {
  const skills = await getRegisteredSkills(userId);
  const skill = skills.find((item) => item.id === skillId);
  if (!skill) return null;
  await ensureSkillStateTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO SkillRegistryState (userId, skillId, enabled, updatedAt) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(userId, skillId) DO UPDATE SET enabled = excluded.enabled, updatedAt = datetime('now')`,
    userId,
    skillId,
    enabled ? 1 : 0,
  );
  return { ...skill, enabled };
}

export async function testSkillMatch(userId: string, skillId: string, message: string): Promise<SkillMatchResult | null> {
  const skills = await getRegisteredSkills(userId);
  const skill = skills.find((item) => item.id === skillId);
  if (!skill) return null;
  const result = scoreRegisteredSkill(skill, message, inferAgent(message, null));
  await ensureSkillStateTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO SkillRegistryState (userId, skillId, enabled, lastUsedAt, usageCount, updatedAt)
     VALUES (?, ?, 1, datetime('now'), 1, datetime('now'))
     ON CONFLICT(userId, skillId) DO UPDATE SET lastUsedAt = datetime('now'), usageCount = usageCount + 1, updatedAt = datetime('now')`,
    userId,
    skillId,
  );
  return {
    skillId,
    matched: result.score >= MIN_CONFIDENCE,
    score: result.score,
    reason: result.reason,
    matchedSignals: result.matchedSignals,
    negativeMatches: result.negativeMatches,
    missingContextQuestions: result.missingContextQuestions,
    skillQualityScore: skill.skillQualityScore,
    skillQualityBand: skill.skillQualityBand,
  };
}

export async function checkDuplicateSkill(userId: string, candidateName: string): Promise<{ duplicate: boolean; message: string; skill?: SkillRegistryEntry }> {
  const normalized = slugify(candidateName);
  const dotted = candidateName.toLowerCase().replace(/\./g, "-");
  const skill = (await getRegisteredSkills(userId, true)).find((item) =>
    item.id === normalized
    || item.id === dotted
    || slugify(item.name) === normalized
    || item.name.toLowerCase() === candidateName.toLowerCase()
  );
  if (!skill) return { duplicate: false, message: `${candidateName} is not installed yet.` };
  return {
    duplicate: true,
    skill,
    message: `${skill.name} is already installed; no action taken.`,
  };
}
