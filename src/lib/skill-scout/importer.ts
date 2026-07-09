import { writeCard } from "@/lib/knowledge-cards";
import { checkDuplicateSkill } from "@/lib/skills/registry";

type SkillScoutImportPayload = {
  candidateName?: unknown;
  sourceRepo?: unknown;
  sourcePath?: unknown;
  sourceUrl?: unknown;
  recommendedAction?: unknown;
  whyItHelps?: unknown;
  riskLevel?: unknown;
  filesExpectedToChange?: unknown;
  rollbackPlan?: unknown;
};

type ImportResult = {
  cardPath: string;
  summary: string;
  skipped?: boolean;
};

const SAFE_SOURCE_PATH_RE = /^[a-zA-Z0-9_./-]+$/;

function cleanText(value: unknown, fallback: string): string {
  return String(value ?? fallback)
    .replace(/[\uFEFF\u200B-\u200D]/g, "")
    .replace(/\s+/g, " ")
    .replace(/—/g, "-")
    .trim()
    .slice(0, 600);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill-scout-item";
}

function validatePayload(payload: SkillScoutImportPayload): {
  name: string;
  id: string;
  sourceRepo: string;
  sourcePath: string;
  sourceUrl: string;
  recommendedAction: string;
  whyItHelps: string;
  riskLevel: string;
  filesExpectedToChange: string[];
  rollbackPlan: string;
} {
  const name = cleanText(payload.candidateName, "Skill Scout item");
  const sourceRepo = cleanText(payload.sourceRepo, "unknown repo");
  const sourcePath = cleanText(payload.sourcePath, "unknown path");
  const sourceUrl = cleanText(payload.sourceUrl, "");
  const recommendedAction = cleanText(payload.recommendedAction, "convert_to_knowledge_card");
  const whyItHelps = cleanText(payload.whyItHelps, "Improves Parawi Builder output.");
  const riskLevel = cleanText(payload.riskLevel, "medium").toLowerCase();
  const rollbackPlan = cleanText(payload.rollbackPlan, "Revert the generated knowledge card.");
  const filesExpectedToChange = Array.isArray(payload.filesExpectedToChange)
    ? payload.filesExpectedToChange.map((item) => cleanText(item, "")).filter(Boolean).slice(0, 8)
    : ["catalog/skills/"];

  if (riskLevel !== "low") {
    throw new Error("Only low-risk Skill Scout items can be imported automatically.");
  }
  if (!sourceUrl.startsWith("https://github.com/")) {
    throw new Error("Skill Scout imports require an HTTPS GitHub source URL.");
  }
  if (!SAFE_SOURCE_PATH_RE.test(sourcePath) || sourcePath.includes("..")) {
    throw new Error("Unsafe source path rejected.");
  }

  return {
    name,
    id: `skill-scout-${slugify(name)}`,
    sourceRepo,
    sourcePath,
    sourceUrl,
    recommendedAction,
    whyItHelps,
    riskLevel,
    filesExpectedToChange,
    rollbackPlan,
  };
}

export async function importApprovedSkillScoutItem(payload: unknown, userId = "system"): Promise<ImportResult> {
  const item = validatePayload(payload as SkillScoutImportPayload);
  const duplicate = await checkDuplicateSkill(userId, item.name);
  if (duplicate.duplicate && duplicate.skill) {
    return {
      cardPath: duplicate.skill.path,
      summary: duplicate.message,
      skipped: true,
    };
  }
  const cardPath = `skills/${item.id}.md`;
  const body = [
    `# ${item.name}`,
    "",
    "## Source",
    `Repository: ${item.sourceRepo}`,
    `Path: ${item.sourcePath}`,
    `URL: ${item.sourceUrl}`,
    "",
    "## Recommended Action",
    item.recommendedAction,
    "",
    "## Why It Helps Parawi",
    item.whyItHelps,
    "",
    "## Guardrails",
    "- Treat this as adapted guidance, not copied executable code.",
    "- Do not run scripts from the source repository.",
    "- Do not import secrets, binaries, lockfiles, build artifacts, or dependency folders.",
    `- Expected Parawi touch points: ${item.filesExpectedToChange.join(", ")}`,
    "",
    "## Rollback",
    item.rollbackPlan,
  ].join("\n");

  await writeCard(cardPath, {
    type: "skill",
    id: item.id,
    updated: new Date().toISOString().slice(0, 10),
    source: "skill-scout",
    source_repo: item.sourceRepo,
    source_path: item.sourcePath,
    recommended_action: item.recommendedAction,
    risk_level: item.riskLevel,
  }, body);

  return {
    cardPath: `catalog/${cardPath}`,
    summary: `Imported ${item.name} as ${cardPath}.`,
  };
}
