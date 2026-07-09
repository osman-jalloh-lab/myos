import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { resolveLocalProjectsRoot } from "@/lib/local-projects-root";

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
  source: "built_in" | "installed" | "scouted";
  validationStatus: "valid" | "missing_metadata" | "invalid";
};

export type SkillRegistryEntry = RegisteredSkill & {
  category: string;
  dateAdded: string | null;
  validationWarnings: string[];
  problemSolved: string;
  instructionFile: string | null;
  instructionPreview: string | null;
};

export type SkillMatchResult = {
  skillId: string;
  matched: boolean;
  score: number;
  reason: string;
};

type SkillStateRow = {
  skillId: string;
  enabled: boolean | number;
  lastUsedAt: Date | string | null;
  usageCount: number | bigint | null;
};

let cache: { createdAt: number; entries: SkillRegistryEntry[] } | null = null;
const CACHE_MS = 60_000;

const PERSONAL_SKILL_IDS = new Set([
  "personal-context-anchor",
  "i9-hr-compliance-specialist",
  "job-application-ops",
  "it-help-desk-trainer",
  "grc-risk-role-screener",
  "student-work-authorization-guard",
  "writing-humanizer",
]);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "skill";
}

function parseFrontMatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, unknown> = {};
  let activeKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) {
      activeKey = pair[1];
      const raw = pair[2].trim();
      out[activeKey] = raw ? raw.replace(/^["']|["']$/g, "") : [];
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && activeKey) {
      const current = Array.isArray(out[activeKey]) ? out[activeKey] as unknown[] : [];
      current.push(item[1].trim().replace(/^["']|["']$/g, ""));
      out[activeKey] = current;
    }
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean).slice(0, 12);
  const text = asString(value);
  return text ? [text] : [];
}

function safetyClassFrom(value: unknown, requiresApproval?: boolean): RegisteredSkill["safetyClass"] {
  const text = asString(value).toLowerCase();
  if (text === "local_execution") return "local_execution";
  if (text === "approval_required" || text === "external_write" || requiresApproval) return "approval_required";
  return "read_only";
}

function costSavingFor(tags: string[], description: string, source: RegisteredSkill["source"]): RegisteredSkill["estimatedCostSaving"] {
  const text = `${tags.join(" ")} ${description}`.toLowerCase();
  if (/routing|triage|draft|brief|context|screen|guard|compliance|trainer/.test(text)) return "medium";
  if (source === "scouted") return "low";
  return "none";
}

function problemSolved(skill: Pick<RegisteredSkill, "name" | "description" | "ownerAgents" | "tags">): string {
  const agent = skill.ownerAgents[0] ? skill.ownerAgents[0][0].toUpperCase() + skill.ownerAgents[0].slice(1) : "Hermes";
  const plain = skill.description.replace(/\.$/, "");
  if (/brief|context|ground/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} turn rough context into a grounded response before an expensive model call.`;
  if (/job|resume|application|role|risk|grc|soc/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} screen career opportunities against Osman's real goals before drafting or outreach.`;
  if (/write|human/i.test(`${skill.name} ${plain}`)) return `This skill can help ${agent} make drafts sound more direct and human before they leave the system.`;
  return plain || `This skill gives ${agent} reusable instructions for a recurring workflow.`;
}

function validationStatus(meta: Record<string, unknown>, hasJson: boolean, hasSkillMd: boolean): Pick<SkillRegistryEntry, "validationStatus" | "validationWarnings"> {
  const warnings: string[] = [];
  if (!hasJson && !hasSkillMd) warnings.push("No safe metadata file found.");
  if (!asString(meta.name)) warnings.push("Missing name.");
  if (!asString(meta.description)) warnings.push("Missing description.");
  if (!asString(meta.safetyClass) && !asString((meta.execution as { risk?: unknown } | undefined)?.risk)) warnings.push("Missing safety class; defaulted to read-only.");
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
    preview: body.slice(0, 2400),
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
    const json = await readJson(path.join(root, `${id}.json`));
    const skillMd = await readSkillMd(path.join(dir, "SKILL.md"));
    const meta = { ...(json ?? {}), ...(skillMd?.meta ?? {}) };
    const execution = meta.execution as { risk?: unknown; requiresApproval?: unknown } | undefined;
    const name = asString(meta.name) || id;
    const description = asString(meta.description) || "Local skill instructions.";
    const ownerAgents = asStringArray(meta.ownerAgents).length ? asStringArray(meta.ownerAgents) : [asString(meta.agent) || "hermes"];
    const tags = asStringArray(meta.tags).length ? asStringArray(meta.tags) : [asString(meta.category)].filter(Boolean);
    const triggerExamples = asStringArray(meta.triggerExamples).length ? asStringArray(meta.triggerExamples) : asStringArray(meta.examples);
    const requiredCapabilities = asStringArray(meta.requiredCapabilities).length
      ? asStringArray(meta.requiredCapabilities)
      : asStringArray((execution as { pipeline?: unknown } | undefined)?.pipeline);
    const safetyClass = safetyClassFrom(meta.safetyClass ?? execution?.risk, Boolean(execution?.requiresApproval));
    const validation = validationStatus(meta, Boolean(json), Boolean(skillMd));
    const info = await stat(json ? path.join(root, `${id}.json`) : dir).catch(() => null);
    const source: RegisteredSkill["source"] = id.startsWith("skill-scout-") ? "scouted" : PERSONAL_SKILL_IDS.has(id) ? "installed" : "built_in";

    skills.push({
      id,
      name,
      description,
      path: json ? path.join(root, `${id}.json`) : dir,
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
      category: asString(meta.category) || tags[0] || "workflow",
      dateAdded: info?.birthtime?.toISOString() ?? null,
      validationWarnings: validation.validationWarnings,
      problemSolved: problemSolved({ name, description, ownerAgents, tags }),
      instructionFile: skillMd ? path.join(dir, "SKILL.md") : null,
      instructionPreview: skillMd?.preview ?? null,
    });
  }
  return skills;
}

async function scanFolderSkills(root: string, sourceLabel: string): Promise<SkillRegistryEntry[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(async (entry) => {
    const dir = path.join(root, entry.name);
    const skillMd = await readSkillMd(path.join(dir, "SKILL.md"));
    const meta = skillMd?.meta ?? {};
    const description = asString(meta.description) || "Local skill instructions.";
    const ownerAgents = asStringArray(meta.ownerAgents).length ? asStringArray(meta.ownerAgents) : ["hermes"];
    const tags = asStringArray(meta.tags).length ? asStringArray(meta.tags) : [sourceLabel];
    const validation = validationStatus(meta, false, Boolean(skillMd));
    const info = await stat(dir).catch(() => null);
    return {
      id: `${sourceLabel}:${entry.name}`,
      name: asString(meta.name) || entry.name,
      description,
      path: dir,
      enabled: true,
      ownerAgents,
      tags,
      triggerExamples: asStringArray(meta.triggerExamples),
      requiredCapabilities: asStringArray(meta.requiredCapabilities),
      safetyClass: safetyClassFrom(meta.safetyClass),
      estimatedCostSaving: costSavingFor(tags, description, "installed"),
      lastUsedAt: null,
      usageCount: 0,
      source: "installed" as const,
      validationStatus: validation.validationStatus,
      category: tags[0] || "workflow",
      dateAdded: info?.birthtime?.toISOString() ?? null,
      validationWarnings: validation.validationWarnings,
      problemSolved: problemSolved({ name: entry.name, description, ownerAgents, tags }),
      instructionFile: skillMd ? path.join(dir, "SKILL.md") : null,
      instructionPreview: skillMd?.preview ?? null,
    };
  }));
}

async function ensureSkillStateTable(): Promise<void> {
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
    const [repo, agent, local] = await Promise.all([
      scanRepoSkills(),
      scanFolderSkills(path.join(os.homedir(), ".agents", "skills"), "agent"),
      scanFolderSkills(path.join(projectsRoot, "skills"), "local"),
    ]);
    const byId = new Map<string, SkillRegistryEntry>();
    for (const skill of [...repo, ...agent, ...local]) if (!byId.has(skill.id)) byId.set(skill.id, skill);
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
  const words = message.toLowerCase().split(/[^a-z0-9+]+/).filter((word) => word.length > 2);
  const haystacks = [skill.name, skill.description, ...skill.tags, ...skill.triggerExamples, ...skill.requiredCapabilities].map((item) => item.toLowerCase());
  const hits = words.filter((word) => haystacks.some((item) => item.includes(word))).slice(0, 12);
  const score = Math.min(100, hits.length * 18 + (skill.triggerExamples.some((example) => message.toLowerCase().includes(example.toLowerCase().slice(0, 16))) ? 20 : 0));
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
    matched: score >= 35,
    score,
    reason: hits.length
      ? `Matched ${hits.join(", ")} against this skill's safe metadata.`
      : "No strong match from safe metadata.",
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
