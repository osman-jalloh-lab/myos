import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import {
  formatFuguDesignGate,
  getFuguDesignGateMode,
  getFuguDesignPassScore,
  runFuguDesignCritique,
  runFuguDesignGate,
  type FuguDesignGate,
  type FuguDesignGateInput,
  type FuguGateMode,
  type FuguGateVerdict,
} from "@/lib/fugu-design-critic";
import { createExecutionQueueTask, updateExecutionQueueTask } from "@/lib/execution-queue";
import { loadAgentKnowledgeContext, type KnowledgeCard } from "@/lib/knowledge-cards";
import { runBrowserQa } from "@/lib/browser-qa";
import {
  DEFAULT_LOCAL_PROJECTS_ROOT,
  isWindowsAbsolute,
  resolveLocalPath,
  resolveLocalProjectsRoot,
} from "@/lib/local-projects-root";

export { DEFAULT_LOCAL_PROJECTS_ROOT };

type Db = ReturnType<typeof createClient>;

export type LocalBuildProject = {
  id: string;
  projectName: string;
  localFolderPath: string;
  status: string;
  createdAt: string;
  currentTask: string;
  taskId: string;
  buildLog: string | null;
  buildError: string | null;
  localDevUrl: string | null;
  localDevPid: number | null;
  previewStatus?: "online" | "offline" | "stale" | null;
  researchBrief: string | null;
  designReview: string | null;
  polishReview: string | null;
  designScore: number | null;
  fuguGateStatus?: FuguGateVerdict | null;
  fuguGateScore?: number | null;
  fuguGateReview?: FuguDesignGate | null;
  fuguGateReviewedAt?: string | null;
  fuguGateOverrideReason?: string | null;
  fuguPolishStatus?: string | null;
  qaStatus: string | null;
  qaChecklist: LocalBuilderQaItem[] | null;
  files?: string[];
};

export type LocalBuilderQaItem = {
  key: string;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
};

export type LocalBuilderRootInfo = {
  root: string;
  exists: boolean;
  projectCount: number;
  warning: string | null;
};

export type CodexCliStatus = {
  installed: boolean;
  available: boolean;
  version: string | null;
  message: string;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  output: string;
  command: string;
  exitCode: number | null;
};

const LOCAL_BUILDER_AGENT = "hermes-local-builder";
const ATHENA_RESEARCH_AGENT = "athena";
const FUGU_DESIGN_AGENT = "fugu";
const CODEX_CLI_EXECUTOR = "codex_cli";
const DEFAULT_CODEX_CLI_MODEL = "gpt-5.4";
const devServers = new Map<string, { child: ReturnType<typeof spawn>; url: string; pid: number | null }>();

export function isServerlessRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

function joinLocalProjectPath(root: string, folderName: string): string {
  return isWindowsAbsolute(root) ? path.win32.join(root, folderName) : path.resolve(root, folderName);
}

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function getLocalProjectsRoot(): Promise<string> {
  return resolveLocalProjectsRoot();
}

export async function getLocalBuilderRootInfo(): Promise<LocalBuilderRootInfo> {
  const root = await getLocalProjectsRoot();
  if (isServerlessRuntime()) {
    return {
      root,
      exists: false,
      projectCount: 0,
      warning: "Serverless runtime cannot access local project folders. Actions are queued for the local worker.",
    };
  }

  const rootExists = await exists(root);
  const entries = rootExists ? await readdir(root, { withFileTypes: true }).catch(() => []) : [];
  const projectCount = entries.filter((entry) => entry.isDirectory()).length;

  return {
    root,
    exists: rootExists,
    projectCount,
    warning: rootExists ? null : "Local builder root folder is missing.",
  };
}

export type BuildRequestAnalysis = {
  projectName: string;
  folderName: string;
  appType: string;
  isEcommerce: boolean;
  isLuxury: boolean;
  isJobCareer: boolean;
  questions: string[];
};

function classifyAppType(message: string): Pick<BuildRequestAnalysis, "appType" | "isEcommerce" | "isLuxury" | "isJobCareer"> {
  const text = message.toLowerCase();
  const isJobCareer = /\b(job|career|application tracker|resume|interview)\b/.test(text);
  const isEcommerce = /\b(ecommerce|e-commerce|marketplace|store|shop|checkout|cart|sell|selling)\b/.test(text);
  const isLuxury = /\b(luxury|premium|high-end|exclusive|collector|boutique)\b/.test(text);
  let appType = "website";
  if (/\bpersonal productivity\b/.test(text)) appType = "personal productivity website";
  else if (/\b(job tracker|application tracker)\b/.test(text)) appType = "job tracker app";
  else if (isJobCareer) appType = "job/career app";
  else if (/\brestaurant\b/.test(text)) appType = "restaurant website";
  else if (/\bportfolio\b/.test(text)) appType = "portfolio website";
  else if (/\b(apartment|rental|property)\b.*\b(finder|search|listing|app|website)\b|\b(apartment finder)\b/.test(text)) appType = "apartment finder app";
  else if (/\b(watch|watches|timepiece|horology)\b/.test(text) && isEcommerce) appType = "watch marketplace";
  else if (isEcommerce) appType = "ecommerce website";
  else if (/\bdashboard\b/.test(text)) appType = "dashboard app";
  else if (/\blanding page\b/.test(text)) appType = "landing page";
  else if (/\b(web app|app)\b/.test(text)) appType = "web app";
  return { appType, isEcommerce, isLuxury, isJobCareer };
}

export function parseLocalBuildRequest(message: string): BuildRequestAnalysis | null {
  const trimmed = message.trim();
  if (!/\b(build|create|make|start|scaffold|generate)\b/i.test(trimmed)) return null;
  if (!/\b(website|site|app|web app|landing page|project|marketplace|store|shop|archive|product|experience)\b/i.test(trimmed)) return null;

  const explicitName =
    trimmed.match(/\b(?:called|named)\s+["'“”‘’]?([^.!?\r\n]{2,80}?)["'“”‘’]?(?=\s+(?:for|with|that|using|in)\b|[.!?]|$)/i)?.[1] ??
    trimmed.match(/\b(?:website|site|app|web app|landing page|project|marketplace|store|shop)\s+["']?([a-z0-9][a-z0-9 _-]{1,70})["']?/i)?.[1] ??
    trimmed.match(/\bbuild(?:\s+me)?\s+(?:a|an)?\s*["']?([a-z0-9][a-z0-9 _-]{1,70}?(?:website|site|app|web app|landing page|project|marketplace|store|shop|archive|product|experience))["']?(?:[.!?]|$)/i)?.[1] ??
    trimmed.match(/\b(?:build|create|make|generate)\s+(?:a|an|the)?\s*["']?([a-z0-9][a-z0-9 _-]{1,70})["']?(?:[.!?]|$)/i)?.[1];

  if (!explicitName) return null;

  const projectName = explicitName
    .replace(/\s+(?:for|with|that|using|in)\b.*$/i, "")
    .replace(/[.!?].*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (projectName.length < 2) return null;

  const folderName = projectName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!folderName) return null;
  const classification = classifyAppType(trimmed);
  const hasPurpose = classification.appType !== "website" || /\bfor\s+(?:a|an|the|my|our)\s+[^.!?]{3,}/i.test(trimmed);
  const questions = hasPurpose ? [] : [
    `What should ${projectName} help people do?`,
    "Who is the primary audience?",
    "What visual style and must-have features should the first version include?",
  ];
  return { projectName, folderName, ...classification, questions };
}

async function ensureLocalBuilderColumns(db: Db): Promise<void> {
  await db.execute(`ALTER TABLE Project ADD COLUMN localFolderPath TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildLog TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevUrl TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevPid INTEGER`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localPreviewStatus TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localPreviewCheckedAt TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localResearchBrief TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDesignReview TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localPolishReview TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN designScore INTEGER`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguGateStatus TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguGateScore INTEGER`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguGateReview TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguGateReviewedAt TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguGateOverrideReason TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN fuguPolishStatus TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localQaStatus TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localQaChecklist TEXT`).catch(() => undefined);
}

function rowString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quotedAfter(message: string, label: string): string | null {
  const quoteChars = "\\\"'\\u201c\\u201d\\u2018\\u2019";
  const match = message.match(new RegExp(`${label}\\s*[${quoteChars}]([^${quoteChars}]+)[${quoteChars}]`, "i"));
  return match?.[1]?.trim() ?? null;
}

function cleanDisplayText(value: string): string {
  return value.replace(/[<>{}]/g, "").trim();
}

function queuedActionLabel(action: string): string {
  switch (action) {
    case "generate": return "Generate app";
    case "open": return "Open folder";
    case "startDev": return "Start dev server";
    case "stopDev": return "Stop dev server";
    case "rebuild": return "Rebuild";
    case "fuguDesignReview": return "Run Fugu design review";
    case "runQa": return "Run QA checklist";
    case "runCodex": return "Run Codex improvement";
    default: return "Prepare local build";
  }
}

function rowNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseQaChecklist(value: unknown): LocalBuilderQaItem[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is LocalBuilderQaItem => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return typeof record.key === "string"
        && typeof record.label === "string"
        && ["passed", "failed", "skipped"].includes(String(record.status))
        && typeof record.detail === "string";
    });
  } catch {
    return null;
  }
}

function parseFuguGateReview(value: unknown): FuguDesignGate | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as FuguDesignGate;
    if (!parsed || typeof parsed !== "object") return null;
    if (!["pass", "revise", "unavailable", "error"].includes(String(parsed.verdict))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function fuguGateStatus(value: unknown): FuguGateVerdict | null {
  const status = rowString(value);
  return status === "pass" || status === "revise" || status === "unavailable" || status === "error" ? status : null;
}

export function canStartBuildWithFuguGate(
  project: { fuguGateStatus?: unknown; fuguGateOverrideReason?: unknown },
  mode: FuguGateMode = getFuguDesignGateMode()
): { allowed: boolean; reason: string } {
  if (mode === "off" || mode === "recommended") return { allowed: true, reason: `Fugu gate mode is ${mode}.` };
  const status = fuguGateStatus(project.fuguGateStatus);
  if (status === "pass") return { allowed: true, reason: "Fugu approved the design direction." };
  if (rowString(project.fuguGateOverrideReason).trim()) return { allowed: true, reason: "Fugu gate override reason is recorded." };
  return {
    allowed: false,
    reason: status
      ? `Fugu design gate is ${status}; required mode blocks normal build until pass or override.`
      : "Fugu design gate has not passed; required mode blocks normal build until pass or override.",
  };
}

function projectGateFields(project: Record<string, unknown>) {
  return {
    fuguGateStatus: fuguGateStatus(project.fuguGateStatus),
    fuguGateScore: rowNumber(project.fuguGateScore),
    fuguGateReview: parseFuguGateReview(project.fuguGateReview),
    fuguGateReviewedAt: rowString(project.fuguGateReviewedAt) || null,
    fuguGateOverrideReason: rowString(project.fuguGateOverrideReason) || null,
    fuguPolishStatus: rowString(project.fuguPolishStatus) || null,
  };
}

function fuguGateInputFromProject(
  projectName: string,
  message: string,
  researchBrief: string,
  project?: Record<string, unknown>
): FuguDesignGateInput {
  const latestInstruction = rowString(project?.latestInstruction) || message;
  return {
    originalIdea: latestInstruction || projectName,
    buildBrief: message || latestInstruction || projectName,
    intendedUsers: researchBrief.match(/audience[^\n]*\n([\s\S]{0,500})/i)?.[1]?.trim() || "Inferred from the Athena research brief.",
    firstReleaseGoal: researchBrief.match(/goal[^\n]*\n([\s\S]{0,500})/i)?.[1]?.trim() || "Ship a polished first local web experience.",
    featurePriorities: researchBrief.match(/feature[^\n]*\n([\s\S]{0,700})/i)?.[1]?.trim() || "Use the Athena feature plan and prioritize complete working flows.",
    visualDirection: researchBrief.match(/visual[^\n]*\n([\s\S]{0,700})/i)?.[1]?.trim() || "Use the Athena design brief.",
    pagesAndComponents: researchBrief.match(/page|component/i) ? researchBrief.slice(0, 2000) : "Use the pages and components implied by the build brief.",
    athenaResearchBrief: researchBrief,
    existingProjectContext: [
      project ? `Status: ${rowString(project.status) || "unknown"}` : null,
      project ? `Existing design review: ${rowString(project.localDesignReview) ? "yes" : "no"}` : null,
      project ? `Existing polish review: ${rowString(project.localPolishReview) ? "yes" : "no"}` : null,
    ].filter(Boolean).join("\n"),
  };
}

async function persistFuguDesignGate(
  db: Db,
  projectId: string,
  currentLog: string,
  gate: FuguDesignGate,
  status?: string
): Promise<string> {
  const review = formatFuguDesignGate(gate);
  const nextLog = [
    currentLog,
    `Fugu Design Gate: ${gate.verdict}${typeof gate.score === "number" ? ` (${gate.score}/10)` : ""}.`,
    gate.summary,
  ].filter(Boolean).join("\n").trim().slice(-12000);
  await db.execute({
    sql: `UPDATE Project SET ${status ? "status = ?, " : ""}localDesignReview = ?, designScore = ?, fuguGateStatus = ?, fuguGateScore = ?, fuguGateReview = ?, fuguGateReviewedAt = ?, fuguGateOverrideReason = NULL, localBuildLog = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [
      ...(status ? [status] : []),
      review,
      gate.score,
      gate.verdict,
      gate.score,
      JSON.stringify(gate),
      gate.reviewedAt,
      nextLog,
      projectId,
    ],
  });
  return nextLog;
}

function fuguGateProjectResult(
  project: Record<string, unknown>,
  projectId: string,
  projectName: string,
  folder: string,
  createdAt: string,
  currentTask: string,
  taskId: string,
  overrides: Partial<LocalBuildProject> = {}
): LocalBuildProject {
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: rowString(project.status) || "Brief Ready",
    createdAt,
    currentTask,
    taskId,
    buildLog: rowString(project.localBuildLog) || null,
    buildError: rowString(project.localBuildError) || null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: rowString(project.localDesignReview) || null,
    polishReview: rowString(project.localPolishReview) || null,
    designScore: rowNumber(project.designScore),
    ...projectGateFields(project),
    qaStatus: rowString(project.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project.localQaChecklist),
    ...overrides,
  };
}

function packageName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "hermes-local-app";
}

async function loadWebsiteBuilderSkills(analysis: BuildRequestAnalysis): Promise<string> {
  const root = path.join(await getLocalProjectsRoot(), "skills");
  const names = [
    "web-product-discovery",
    "interaction-design",
    "frontend-qa",
    "visual-polish-review",
    ...(analysis.isEcommerce ? ["ecommerce-build"] : []),
    ...(analysis.isLuxury ? ["luxury-ui-design"] : []),
  ];
  const files = await Promise.all(names.map(async (name) => {
    const content = await readFile(path.join(root, name, "SKILL.md"), "utf8").catch(() => "");
    return content ? `## ${name}\n${content.trim()}` : `## ${name}\nMissing local skill file.`;
  }));
  return files.join("\n\n");
}

function summarizeKnowledgeCard(card: KnowledgeCard): string {
  const title = typeof card.frontmatter.id === "string" ? card.frontmatter.id : card.path;
  const tags = Array.isArray(card.frontmatter.tags) ? ` [${card.frontmatter.tags.join(", ")}]` : "";
  const body = card.body.replace(/\s+/g, " ").trim();
  return `- ${card.path}${tags}: ${title}. ${body.slice(0, 520)}`;
}

async function loadBuilderKnowledgeContext(projectName: string, message: string): Promise<string> {
  const cards = await loadAgentKnowledgeContext("builder").catch(() => []);
  if (!cards.length) return "No Builder knowledge cards loaded.";

  const analysis = classifyAppType(`${projectName} ${message}`);
  const text = `${projectName} ${message} ${analysis.appType}`.toLowerCase();
  const eligible = cards.filter((card) => {
    const tags = Array.isArray(card.frontmatter.tags) ? card.frontmatter.tags.map((tag) => String(tag).toLowerCase()) : [];
    const haystack = `${card.path} ${tags.join(" ")}`.toLowerCase();
    if (/luxury|chrono/.test(haystack) && !analysis.isLuxury) return false;
    if (/ecommerce|marketplace/.test(haystack) && !analysis.isEcommerce) return false;
    if (/\b(job|career)\b/.test(haystack) && !analysis.isJobCareer) return false;
    return card.path.startsWith("design/") || card.path.startsWith("skills/") || card.path.startsWith("preferences/");
  });
  const scored = eligible.map((card) => {
    const haystack = `${card.path} ${JSON.stringify(card.frontmatter)} ${card.body}`.toLowerCase();
    const score = text.split(/\W+/).filter((token) => token.length > 3 && haystack.includes(token)).length;
    const builderTag = Array.isArray(card.frontmatter.tags) && card.frontmatter.tags.includes("builder") ? 2 : 0;
    return { card, score: score + builderTag };
  });

  return scored
    .filter((entry) => entry.score > 0 || ["preferences", "skills"].some((part) => entry.card.path.startsWith(`${part}/`)) || /accessibility|qa|responsive|principles|typography|spacing/.test(entry.card.path))
    .sort((a, b) => b.score - a.score || a.card.path.localeCompare(b.card.path))
    .slice(0, 8)
    .map((entry) => summarizeKnowledgeCard(entry.card))
    .join("\n") || "No relevant Builder knowledge cards matched.";
}

async function createAthenaResearchBrief(projectName: string, message: string): Promise<string> {
  const parsed = parseLocalBuildRequest(message);
  const analysis: BuildRequestAnalysis = parsed ?? { projectName, folderName: projectName, ...classifyAppType(message), questions: [] };
  const skillSource = await loadWebsiteBuilderSkills(analysis);
  const builderKnowledge = await loadBuilderKnowledgeContext(projectName, message);
  const scope = analysis.isEcommerce
    ? "Include only commerce behavior supported by the request, such as catalog, cart, checkout, inquiry, or marketplace flows."
    : analysis.isJobCareer
    ? "Prioritize application, interview, follow-up, status, and career workflow needs that are actually requested."
    : `Design the information architecture and interactions appropriate for a ${analysis.appType}.`;

  return [
    `Hermes website builder skill workflow for ${projectName}`,
    `Project name: ${projectName}`,
    `App type: ${analysis.appType}`,
    `Questions asked: ${analysis.questions.length ? analysis.questions.join(" | ") : "none; the request supplied enough direction"}`,
    `Questions answered from request: ${analysis.questions.length ? "pending" : message}`,
    "",
    "Loaded local skill files:",
    skillSource.split("\n").filter((line) => line.startsWith("## ")).map((line) => `- ${line.replace(/^## /, "")}`).join("\n"),
    "",
    "Loaded Builder knowledge cards:",
    builderKnowledge,
    "",
    `Product brief: Build ${projectName} as a ${analysis.appType}. Do not infer ecommerce, marketplace, luxury, watches, or a dark visual theme unless the request explicitly calls for them.`,
    "",
    `Feature plan: ${scope} Use the user's terminology and domain; do not recycle content from unrelated example projects.`,
    "",
    "Build plan: Use Next.js App Router and TypeScript by default. Create a useful first version with working requested interactions, responsive behavior, semantic HTML, and visible focus states.",
    "",
    "QA checklist: npm run build passes; requested content and controls work; responsive layout does not overlap; accessibility checks pass; no dead buttons or unrelated domain content.",
  ].join("\n");
}

async function jobTrackerTemplateFiles(projectName: string): Promise<Record<string, string> | null> {
  const templateRoot = path.join(await getLocalProjectsRoot(), "JobFlow");
  if (!(await exists(templateRoot))) return null;

  const files = [
    "package.json",
    "BUILDER_PLAN.md",
    "next.config.mjs",
    "tsconfig.json",
    "next-env.d.ts",
    "src/app/layout.tsx",
    "src/app/global-error.tsx",
    "src/app/icon.svg",
    "src/app/page.tsx",
    "src/app/globals.css",
  ];
  const safeName = cleanDisplayText(projectName);
  const output: Record<string, string> = {};
  for (const file of files) {
    const source = await readFile(path.join(templateRoot, ...file.split("/")), "utf8");
    output[file] = source.replaceAll("JobFlow", safeName).replaceAll("jobflow", packageName(projectName));
  }
  return output;
}

function luxuryWatchPageTsx(safeName: string, heading: string, button: string): string {
  return `"use client";

import { useMemo, useState } from "react";

const brandName = ${JSON.stringify(safeName)};
const heroHeading = ${JSON.stringify(heading)};
const primaryAction = ${JSON.stringify(button)};
const watches = [
  { id: 1, name: "Aurelian Sector", type: "Dress", price: 12800, year: 1968, size: "36 mm", material: "Yellow gold", condition: "Excellent", city: "Geneva", trust: "Authenticated", movement: "Manual" },
  { id: 2, name: "Mariner 300", type: "Diver", price: 9400, year: 1982, size: "40 mm", material: "Steel", condition: "Very good", city: "Austin", trust: "Escrow ready", movement: "Automatic" },
  { id: 3, name: "Atelier Moonphase", type: "Independent", price: 22100, year: 2021, size: "39 mm", material: "Rose gold", condition: "Unworn", city: "New York", trust: "Maker papers", movement: "Automatic" },
];

export default function Home() {
  const [type, setType] = useState("All");
  const [saved, setSaved] = useState<number[]>([]);
  const [compare, setCompare] = useState<number[]>([]);
  const [selected, setSelected] = useState(watches[0]);
  const [checkout, setCheckout] = useState("Concierge idle");
  const visible = useMemo(() => type === "All" ? watches : watches.filter((watch) => watch.type === type), [type]);
  const toggle = (list: number[], id: number) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  return (
    <main className="page">
      <section className="hero" aria-label={\`\${brandName} marketplace\`}>
        <div className="heroCopy">
          <p className="eyebrow">{brandName}</p>
          <h1>{heroHeading}</h1>
          <p className="lede">A refined marketplace concept for authenticated timepieces, private sourcing, and collector-grade discovery.</p>
          <div className="heroActions">
            <a href="#market">{primaryAction}</a>
            <button type="button" onClick={() => setCheckout("Private sourcing request drafted")}>Request sourcing</button>
          </div>
        </div>
        <div className="watchStage" aria-hidden="true">
          <div className="watchFace"><span /></div>
        </div>
      </section>

      <section className="trust" aria-label="Marketplace trust signals">
        <span>Authenticated listings</span>
        <span>Escrow-ready sellers</span>
        <span>Original generated-safe staging</span>
      </section>

      <section id="market" className="market" aria-label="Watch marketplace">
        <div className="marketHeader">
          <div>
            <p className="eyebrow">Collector desk</p>
            <h2>Curated inventory with real decision tools</h2>
          </div>
          <div className="filters" aria-label="Collection filters">
            {["All", "Dress", "Diver", "Independent"].map((item) => (
              <button key={item} type="button" className={type === item ? "active" : ""} onClick={() => setType(item)}>{item}</button>
            ))}
          </div>
        </div>

        <div className="workspace">
          <div className="catalog">
            {visible.map((watch) => (
              <article key={watch.id}>
                <button type="button" className="imageButton" onClick={() => setSelected(watch)} aria-label={\`Open details for \${watch.name}\`}><span /></button>
                <div className="cardTop"><h3>{watch.name}</h3><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(watch.price)}</strong></div>
                <p>{watch.year} / {watch.condition} / {watch.size} / {watch.city}</p>
                <div className="cardActions">
                  <button type="button" onClick={() => setSelected(watch)}>Details</button>
                  <button type="button" onClick={() => setSaved((items) => toggle(items, watch.id))}>{saved.includes(watch.id) ? "Saved" : "Save"}</button>
                  <button type="button" onClick={() => setCompare((items) => toggle(items, watch.id))}>{compare.includes(watch.id) ? "Comparing" : "Compare"}</button>
                </div>
              </article>
            ))}
          </div>

          <aside className="detail" aria-label="Selected watch detail">
            <p className="eyebrow">Detail view</p>
            <h2>{selected.name}</h2>
            <dl>
              <div><dt>Authentication</dt><dd>{selected.trust}</dd></div>
              <div><dt>Movement</dt><dd>{selected.movement}</dd></div>
              <div><dt>Material</dt><dd>{selected.material}</dd></div>
              <div><dt>Case</dt><dd>{selected.size}</dd></div>
            </dl>
            <button type="button" onClick={() => setCheckout(\`Inquiry opened for \${selected.name}\`)}>Start secure inquiry</button>
            <p className="status">{checkout}</p>
            <div className="compareBox">Saved: {saved.length} / Compare: {compare.length}</div>
          </aside>
        </div>
      </section>
    </main>
  );
}
`;
}

function luxuryWatchCss(): string {
  return `:root {
  color-scheme: dark;
  background: #101312;
  color: #f8f4ea;
  font-family: Arial, Helvetica, sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; }

button {
  width: fit-content;
  border: 1px solid #d9b76c;
  border-radius: 8px;
  padding: 14px 22px;
  background: #d9b76c;
  color: #12110f;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 3px solid #fff8e8;
  outline-offset: 3px;
}

.page { min-height: 100vh; background: linear-gradient(145deg, #101312 0%, #1b2320 48%, #4b3d2a 100%); }
.hero { min-height: 82vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); align-items: center; gap: 48px; width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 64px 0 38px; }
.heroCopy { display: grid; gap: 20px; }
.eyebrow { margin: 0; color: #d9b76c; font-size: 13px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
h1 { max-width: 780px; margin: 0; color: #fff8e8; font-family: Georgia, 'Times New Roman', serif; font-size: clamp(48px, 8vw, 96px); line-height: 0.95; letter-spacing: 0; }
.lede { max-width: 620px; margin: 0; color: #d7d1c3; font-size: 18px; line-height: 1.7; }
.watchStage { aspect-ratio: 1; border: 1px solid rgba(217, 183, 108, 0.32); border-radius: 8px; display: grid; place-items: center; background: radial-gradient(circle at 50% 45%, rgba(217, 183, 108, 0.26), transparent 34%), linear-gradient(160deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02)); }
.watchFace { width: 62%; aspect-ratio: 1; border-radius: 50%; border: 14px solid #d9b76c; display: grid; place-items: center; background: radial-gradient(circle, #20251f 0 58%, #0f1311 59% 100%); box-shadow: 0 28px 80px rgba(0,0,0,0.44); }
.watchFace span { width: 42%; height: 2px; background: #fff8e8; transform: rotate(-35deg); transform-origin: right center; }
.trust { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: rgba(217, 183, 108, 0.25); color: #f8f4ea; }
.trust span { background: rgba(16, 19, 18, 0.86); padding: 18px 24px; text-align: center; font-size: 13px; font-weight: 800; text-transform: uppercase; }
.heroActions, .filters, .cardActions { display: flex; flex-wrap: wrap; gap: 10px; }
.heroActions a { display: inline-flex; align-items: center; border: 1px solid #d9b76c; border-radius: 8px; padding: 14px 22px; background: #d9b76c; color: #12110f; font-size: 15px; font-weight: 800; text-decoration: none; }
.heroActions button, .filters button, .cardActions button { background: rgba(248, 244, 234, 0.07); color: #fff8e8; }
.filters .active { background: #d9b76c; color: #12110f; }
.market { width: min(1180px, calc(100% - 40px)); margin: 0 auto; padding: 56px 0 80px; }
.marketHeader { display: flex; justify-content: space-between; align-items: end; gap: 24px; margin-bottom: 18px; }
.marketHeader h2 { max-width: 620px; margin: 18px 0 8px; color: #fff8e8; font-family: Georgia, 'Times New Roman', serif; font-size: 25px; letter-spacing: 0; }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); gap: 18px; align-items: start; }
.catalog { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
article { min-height: 230px; border: 1px solid rgba(217, 183, 108, 0.22); border-radius: 8px; padding: 22px; background: rgba(248, 244, 234, 0.06); }
.imageButton { width: 100%; aspect-ratio: 1.25; display: grid; place-items: center; padding: 0; background: radial-gradient(circle at 50% 48%, rgba(217,183,108,.25), transparent 32%), #151917; }
.imageButton span { width: 74px; aspect-ratio: 1; border-radius: 50%; border: 8px solid #d9b76c; background: #0f1311; }
.cardTop { display: grid; gap: 8px; margin-top: 16px; }
h3 { margin: 0; color: #fff8e8; font-family: Georgia, Times New Roman, serif; font-size: 21px; }
.cardTop strong { color: #d9b76c; }
article p { margin: 0; color: #c5beb0; line-height: 1.55; }
.cardActions { margin-top: 16px; }
.cardActions button, .filters button { padding: 9px 12px; font-size: 12px; }
.detail { position: sticky; top: 18px; border: 1px solid rgba(217, 183, 108, 0.28); border-radius: 8px; padding: 22px; background: rgba(16, 19, 18, 0.78); }
.detail h2 { margin: 18px 0 8px; color: #fff8e8; font-family: Georgia, 'Times New Roman', serif; font-size: 25px; letter-spacing: 0; }
dl { display: grid; gap: 10px; margin: 18px 0; }
dl div { display: flex; justify-content: space-between; gap: 14px; border-bottom: 1px solid rgba(217, 183, 108, 0.16); padding-bottom: 8px; }
dt { color: #c5beb0; }
dd { margin: 0; color: #fff8e8; text-align: right; }
.status, .compareBox { margin-top: 14px; color: #d9b76c; font-weight: 800; }

@media (max-width: 960px) {
  .workspace, .catalog { grid-template-columns: 1fr; }
  .detail { position: static; }
}

@media (max-width: 820px) {
  .hero, .trust { grid-template-columns: 1fr; }
  .watchStage { max-width: 420px; width: 100%; margin: 0 auto; }
}
`;
}

async function appFiles(projectName: string, message: string, researchBrief?: string | null, designReview?: string | null, knowledgeContext?: string | null): Promise<Record<string, string>> {
  const heading = cleanDisplayText(
    quotedAfter(message, "heading(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "landing page(?:\\s+that\\s+says)?") ??
    `${projectName} is live`
  );
  const button = cleanDisplayText(
    quotedAfter(message, "one\\s+button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    "Start"
  );
  const safeName = cleanDisplayText(projectName);
  const briefText = researchBrief?.trim() || "No Athena research brief was attached.";
  const reviewText = designReview?.trim() || "No Fugu design review was attached.";
  const knowledgeText = knowledgeContext?.trim() || "No Builder knowledge cards were loaded.";
  const isLuxuryWatch = /\b(watch|watches|chrono|timepiece|horology)\b/i.test(`${projectName} ${message} ${briefText} ${reviewText} ${knowledgeText}`);
  const isJobTracker = /\b(job|application|applicant|interview|resume|tracker|jobflow)\b/i.test(`${projectName} ${message} ${briefText} ${reviewText}`);

  if (isJobTracker) {
    const template = await jobTrackerTemplateFiles(projectName);
    if (template) return template;
  }

  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({
      name: packageName(projectName),
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
      },
      dependencies: {
        next: "^16.0.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        "@types/react": "^19.0.0",
        typescript: "^5.6.0",
      },
    }, null, 2)}\n`,
    "README.md": `# ${safeName}\n\nGenerated by Hermes Local Builder using an internal Athena research brief, Builder knowledge cards, and Fugu design review.\n\n## Athena Research Brief\n\n${briefText}\n\n## Builder Knowledge Cards\n\n${knowledgeText}\n\n## Fugu Design Review\n\n${reviewText}\n\n## Commands\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm run dev\n\`\`\`\n`,
    "BUILDER_PLAN.md": `# ${safeName} Builder Plan\n\n## Product Brief\n\n${briefText}\n\n## Builder Knowledge Cards\n\n${knowledgeText}\n\n## Fugu Design Review\n\n${reviewText}\n\n## Design Brief\n\nOriginal visual direction only. Do not copy brand layouts, product photography, or copyrighted assets.\n\n## Feature Plan\n\nInclude real sections, clickable controls, stateful interactions, empty states, and responsive behavior appropriate to the prompt.\n\n## Build Plan\n\nGenerate a working Next.js app with visible product structure and local demo behavior before running install and build.\n\n## QA Checklist\n\n- npm run build passes\n- Main buttons work\n- Navigation works\n- Filters or core controls work\n- Saved/compare or equivalent state works when relevant\n- Mobile layout works\n- App feels like a real product\n- No copied assets\n`,
    "next.config.mjs": `const nextConfig = {};\n\nexport default nextConfig;\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }, null, 2)}\n`,
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is generated by Next.js. Do not edit it directly.\n`,
    "src/app/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect width="64" height="64" rx="12" fill="#101312"/>\n  <circle cx="32" cy="32" r="18" fill="#1f251f" stroke="#d9b76c" stroke-width="5"/>\n  <path d="M32 18v14l11 7" fill="none" stroke="#fff8e8" stroke-width="3" stroke-linecap="round"/>\n  <circle cx="32" cy="32" r="2.5" fill="#fff8e8"/>\n</svg>\n`,
    "src/app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "${safeName}",\n  description: "Generated by Hermes Local Builder",\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    "src/app/global-error.tsx": `"use client";\n\nexport default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {\n  return (\n    <html lang="en">\n      <body>\n        <main className="errorPage">\n          <p className="eyebrow">Build preview</p>\n          <h1>Something went wrong</h1>\n          <p className="lede">{error.message || "The app hit an unexpected rendering error."}</p>\n          <button type="button" onClick={reset}>Try again</button>\n        </main>\n      </body>\n    </html>\n  );\n}\n`,
    "src/app/page.tsx": isLuxuryWatch ? `const collections = ["Dress Icons", "Modern Divers", "Independent Makers"];\n\nexport default function Home() {\n  return (\n    <main className="page">\n      <section className="hero" aria-label="${safeName} landing page">\n        <div className="heroCopy">\n          <p className="eyebrow">${safeName}</p>\n          <h1>${heading}</h1>\n          <p className="lede">A refined marketplace concept for authenticated timepieces, private sourcing, and collector-grade discovery.</p>\n          <button type="button">${button}</button>\n        </div>\n        <div className="watchStage" aria-hidden="true">\n          <div className="watchFace"><span /></div>\n        </div>\n      </section>\n\n      <section className="trust" aria-label="Marketplace trust signals">\n        <span>Authenticated listings</span>\n        <span>Concierge sourcing</span>\n        <span>Original editorial guidance</span>\n      </section>\n\n      <section className="collections" aria-label="Featured collections">\n        {collections.map((item) => (\n          <article key={item}>\n            <div className="miniWatch" aria-hidden="true" />\n            <h2>{item}</h2>\n            <p>Curated direction, generated-safe product staging, and original copy for a premium first impression.</p>\n          </article>\n        ))}\n      </section>\n    </main>\n  );\n}\n` : `export default function Home() {\n  return (\n    <main className="page">\n      <section className="hero" aria-label="${safeName} landing page">\n        <p className="eyebrow">${safeName}</p>\n        <h1>${heading}</h1>\n        <p className="lede">Built from an Athena research brief with original copy, responsive layout, and generated-safe visual direction.</p>\n        <button type="button">${button}</button>\n      </section>\n    </main>\n  );\n}\n`,
    "src/app/globals.css": isLuxuryWatch ? `:root {\n  color-scheme: dark;\n  background: #101312;\n  color: #f8f4ea;\n  font-family: Arial, Helvetica, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n}\n\nbutton {\n  width: fit-content;\n  border: 1px solid #d9b76c;\n  border-radius: 8px;\n  padding: 14px 22px;\n  background: #d9b76c;\n  color: #12110f;\n  font-size: 15px;\n  font-weight: 800;\n  cursor: pointer;\n}\n\nbutton:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {\n  outline: 3px solid #fff8e8;\n  outline-offset: 3px;\n}\n\n.page {\n  min-height: 100vh;\n  background: linear-gradient(145deg, #101312 0%, #1b2320 48%, #4b3d2a 100%);\n}\n\n.hero {\n  min-height: 82vh;\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);\n  align-items: center;\n  gap: 48px;\n  width: min(1120px, calc(100% - 40px));\n  margin: 0 auto;\n  padding: 64px 0 38px;\n}\n\n.heroCopy {\n  display: grid;\n  gap: 20px;\n}\n\n.eyebrow {\n  margin: 0;\n  color: #d9b76c;\n  font-size: 13px;\n  font-weight: 800;\n  letter-spacing: 0.14em;\n  text-transform: uppercase;\n}\n\nh1 {\n  max-width: 780px;\n  margin: 0;\n  color: #fff8e8;\n  font-family: Georgia, 'Times New Roman', serif;\n  font-size: clamp(48px, 8vw, 96px);\n  line-height: 0.95;\n  letter-spacing: 0;\n}\n\n.lede {\n  max-width: 620px;\n  margin: 0;\n  color: #d7d1c3;\n  font-size: 18px;\n  line-height: 1.7;\n}\n\n.watchStage {\n  aspect-ratio: 1;\n  border: 1px solid rgba(217, 183, 108, 0.32);\n  border-radius: 8px;\n  display: grid;\n  place-items: center;\n  background: radial-gradient(circle at 50% 45%, rgba(217, 183, 108, 0.26), transparent 34%), linear-gradient(160deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02));\n}\n\n.watchFace {\n  width: 62%;\n  aspect-ratio: 1;\n  border-radius: 50%;\n  border: 14px solid #d9b76c;\n  display: grid;\n  place-items: center;\n  background: radial-gradient(circle, #20251f 0 58%, #0f1311 59% 100%);\n  box-shadow: 0 28px 80px rgba(0,0,0,0.44);\n}\n\n.watchFace span {\n  width: 42%;\n  height: 2px;\n  background: #fff8e8;\n  transform: rotate(-35deg);\n  transform-origin: right center;\n}\n\n.trust {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 1px;\n  background: rgba(217, 183, 108, 0.25);\n  color: #f8f4ea;\n}\n\n.trust span {\n  background: rgba(16, 19, 18, 0.86);\n  padding: 18px 24px;\n  text-align: center;\n  font-size: 13px;\n  font-weight: 800;\n  text-transform: uppercase;\n}\n\n.collections {\n  width: min(1120px, calc(100% - 40px));\n  margin: 0 auto;\n  padding: 44px 0 72px;\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 16px;\n}\n\narticle {\n  min-height: 230px;\n  border: 1px solid rgba(217, 183, 108, 0.22);\n  border-radius: 8px;\n  padding: 22px;\n  background: rgba(248, 244, 234, 0.06);\n}\n\n.miniWatch {\n  width: 68px;\n  aspect-ratio: 1;\n  border-radius: 50%;\n  border: 7px solid #d9b76c;\n  background: #151917;\n}\n\nh2 {\n  margin: 18px 0 8px;\n  color: #fff8e8;\n  font-family: Georgia, 'Times New Roman', serif;\n  font-size: 25px;\n  letter-spacing: 0;\n}\n\narticle p {\n  margin: 0;\n  color: #c5beb0;\n  line-height: 1.55;\n}\n\n@media (max-width: 820px) {\n  .hero, .collections, .trust {\n    grid-template-columns: 1fr;\n  }\n\n  .watchStage {\n    max-width: 420px;\n    width: 100%;\n    margin: 0 auto;\n  }\n}\n` : `:root {\n  color-scheme: dark;\n  background: #101820;\n  color: #f7fbff;\n  font-family: Arial, Helvetica, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n}\n\n.page {\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 32px;\n  background: linear-gradient(135deg, #101820 0%, #1f3a3d 52%, #f2b84b 100%);\n}\n\n.hero {\n  width: min(760px, 100%);\n  display: grid;\n  gap: 22px;\n  text-align: center;\n}\n\n.eyebrow {\n  margin: 0;\n  color: #f2b84b;\n  font-size: 13px;\n  font-weight: 700;\n  letter-spacing: 0.14em;\n  text-transform: uppercase;\n}\n\nh1 {\n  margin: 0;\n  color: #ffffff;\n  font-size: clamp(44px, 9vw, 84px);\n  line-height: 0.95;\n  letter-spacing: 0;\n}\n\n.lede {\n  margin: 0;\n  color: #d8e4ef;\n  font-size: 17px;\n  line-height: 1.6;\n}\n\nbutton {\n  justify-self: center;\n  min-width: 132px;\n  border: 0;\n  border-radius: 8px;\n  padding: 14px 22px;\n  background: #ffffff;\n  color: #101820;\n  font-size: 16px;\n  font-weight: 800;\n  cursor: pointer;\n}\n\nbutton:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {\n  outline: 3px solid #ffffff;\n  outline-offset: 3px;\n}\n`,
  };

  if (isLuxuryWatch) {
    files["src/app/page.tsx"] = luxuryWatchPageTsx(safeName, heading, button);
    files["src/app/globals.css"] = luxuryWatchCss();
  }

  return files;
}

function childProcessEnv(nodeEnv?: "development" | "production" | "test"): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "NODE_ENV") env[key] = value;
  }
  if (nodeEnv) {
    env.NODE_ENV = nodeEnv;
  } else if (process.env.NODE_ENV && ["development", "production", "test"].includes(process.env.NODE_ENV)) {
    env.NODE_ENV = process.env.NODE_ENV;
  }
  return env as NodeJS.ProcessEnv;
}

function codexProcessEnv(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "APPDATA",
    "ComSpec",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
  ]);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key)) env[key] = value;
  }
  env.NODE_ENV = "development";
  return env as NodeJS.ProcessEnv;
}

function commandForLog(command: string, args: string[]): string {
  return [command, ...args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg)].join(" ");
}

async function runDetailed(
  command: string,
  args: string[],
  cwd: string,
  options: { nodeEnv?: "development" | "production" | "test"; timeoutMs?: number; env?: NodeJS.ProcessEnv; displayCommand?: string; input?: string } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const commandArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, commandArgs, {
      cwd,
      shell: false,
      env: options.env ?? childProcessEnv(options.nodeEnv),
    });
    let stdout = "";
    let stderr = "";
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
    const timeout = setTimeout(() => {
      child.kill();
      const output = `${stdout}\n${stderr}\nCommand timed out.`.trim().slice(-12000);
      finish({ ok: false, stdout: stdout.slice(-8000), stderr: `${stderr}\nCommand timed out.`.trim().slice(-8000), output, command: options.displayCommand ?? commandForLog(command, args), exitCode: null });
    }, options.timeoutMs ?? 180_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({ ok: false, stdout: stdout.slice(-8000), stderr: error.message, output: `${stdout}\n${error.message}`.trim().slice(-12000), command: options.displayCommand ?? commandForLog(command, args), exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = `${stdout}\n${stderr}`.trim().slice(-12000);
      finish({ ok: code === 0, stdout: stdout.trim().slice(-8000), stderr: stderr.trim().slice(-8000), output, command: options.displayCommand ?? commandForLog(command, args), exitCode: code });
    });
  });
}

async function run(command: string, args: string[], cwd: string, nodeEnv?: "development" | "production" | "test"): Promise<{ ok: boolean; output: string }> {
  const result = await runDetailed(command, args, cwd, { nodeEnv });
  return { ok: result.ok, output: result.output.slice(-8000) };
}

async function updateProjectBuildState(db: Db, projectId: string, status: string, log: string, error: string | null = null): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localBuildLog = ?, localBuildError = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, log.slice(-12000), error?.slice(0, 4000) ?? null, projectId],
  });
}

async function updateProjectDevState(db: Db, projectId: string, status: string, url: string | null, pid: number | null, log: string): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localDevUrl = ?, localDevPid = ?, localPreviewStatus = ?, localPreviewCheckedAt = datetime('now'), localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, url, pid, status === "Dev Server Running" ? "online" : status === "Preview Stale" ? "stale" : "offline", log.slice(-12000), projectId],
  });
}

async function findLocalBuildProject(db: Db, userId: string, projectId: string): Promise<Record<string, unknown>> {
  await ensureLocalBuilderColumns(db);
  const res = await db.execute({
    sql: `SELECT * FROM Project WHERE id = ? AND userId = ? LIMIT 1`,
    args: [projectId, userId],
  });
  if (!res.rows.length) throw new Error("Prepared local project was not found.");
  return res.rows[0] as Record<string, unknown>;
}

async function resolveProjectFolder(project: Record<string, unknown>): Promise<{ projectName: string; folder: string; createdAt: string }> {
  const projectName = rowString(project.projectName);
  const localFolderPath = rowString(project.localFolderPath);
  const createdAt = rowString(project.createdAt) || new Date().toISOString();
  if (!projectName || !localFolderPath) throw new Error("Project is missing its local folder path.");

  const root = await getLocalProjectsRoot();
  const resolvedRoot = path.resolve(root);
  const resolvedFolder = path.resolve(localFolderPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedFolder !== resolvedRoot && !resolvedFolder.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }

  return { projectName, folder: resolvedFolder, createdAt };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function nextAvailablePort(start = 3000): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("No available localhost port found between 3000 and 3049.");
}

async function killProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = process.platform === "win32"
      ? spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" })
      : spawn("kill", ["-TERM", String(pid)], { shell: false, stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function logLocalBuilderRun(db: Db, status: string, input: string, output: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', ?, datetime('now'))`,
    args: [crypto.randomUUID(), LOCAL_BUILDER_AGENT, input, output.slice(0, 2000), status],
  }).catch(() => undefined);
}

async function logAthenaResearchRun(db: Db, projectName: string, brief: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'internal', 'completed', datetime('now'))`,
    args: [crypto.randomUUID(), ATHENA_RESEARCH_AGENT, `research_build_brief project=${projectName}`, brief.slice(0, 2000)],
  }).catch(() => undefined);
}

async function previewResponds(url: string, timeoutMs = 2_500): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForPreview(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await previewResponds(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Preview did not become ready within ${Math.round(timeoutMs / 1000)} seconds: ${url}`);
}

async function logFuguRun(db: Db, projectName: string, phase: "design" | "polish", review: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'sakana', 'completed', datetime('now'))`,
    args: [crypto.randomUUID(), FUGU_DESIGN_AGENT, `${phase}_review project=${projectName}`, review.slice(0, 2000)],
  }).catch(() => undefined);
}

async function summarizeGeneratedPage(folder: string): Promise<string> {
  const files = [
    "src/app/page.tsx",
    "src/app/globals.css",
    "src/app/layout.tsx",
    "BUILDER_PLAN.md",
    "README.md",
  ];
  const summaries = await Promise.all(files.map(async (file) => {
    const content = await readFile(path.join(folder, ...file.split("/")), "utf8").catch(() => "");
    if (!content.trim()) return "";
    return `## ${file}\n${content.slice(0, 3500)}`;
  }));
  return summaries.filter(Boolean).join("\n\n") || "No generated app files found yet.";
}

async function readGeneratedAppFiles(folder: string): Promise<{ page: string; css: string; plan: string }> {
  const [page, css, plan] = await Promise.all([
    readFile(path.join(folder, "src", "app", "page.tsx"), "utf8").catch(() => ""),
    readFile(path.join(folder, "src", "app", "globals.css"), "utf8").catch(() => ""),
    readFile(path.join(folder, "BUILDER_PLAN.md"), "utf8").catch(() => ""),
  ]);
  return { page, css, plan };
}

function isIgnoredProjectPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith("node_modules/")
    || normalized.startsWith(".next/")
    || normalized.startsWith(".git/")
    || normalized === "tsconfig.tsbuildinfo";
}

function isSecretProjectPath(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  return basename === ".env"
    || basename.startsWith(".env.")
    || normalized.includes("/.env")
    || /secret|credential|private-key|id_rsa|token/.test(basename);
}

async function listProjectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (isIgnoredProjectPath(relative)) continue;
    if (entry.isDirectory()) {
      files.push(...await listProjectFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function collectProjectSnapshot(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const files = await listProjectFiles(root);
  await Promise.all(files.map(async (file) => {
    const content = await readFile(path.join(root, file), "utf8").catch(() => "");
    snapshot.set(file, content);
  }));
  return snapshot;
}

async function changedFilesSince(root: string, before: Map<string, string>): Promise<string[]> {
  const afterFiles = await listProjectFiles(root);
  const after = new Set(afterFiles);
  const changed = new Set<string>();
  await Promise.all(afterFiles.map(async (file) => {
    const content = await readFile(path.join(root, file), "utf8").catch(() => "");
    if (!before.has(file) || before.get(file) !== content) changed.add(file);
  }));
  for (const file of before.keys()) {
    if (!after.has(file)) changed.add(file);
  }
  return Array.from(changed).sort();
}

async function restoreSecretFileChanges(root: string, before: Map<string, string>, changedFiles: string[]): Promise<string[]> {
  const touchedSecrets = changedFiles.filter(isSecretProjectPath);
  await Promise.all(touchedSecrets.map(async (file) => {
    const absolute = path.join(root, file);
    if (before.has(file)) {
      await writeFile(absolute, before.get(file) ?? "", "utf8").catch(() => undefined);
    } else {
      await unlink(absolute).catch(() => undefined);
    }
  }));
  return touchedSecrets;
}

export async function getCodexCliStatus(): Promise<CodexCliStatus> {
  if (isServerlessRuntime()) {
    return {
      installed: false,
      available: false,
      version: null,
      message: "Codex CLI runs only on the local worker; serverless requests are queued.",
    };
  }

  const root = await getLocalProjectsRoot();
  const result = await runDetailed("codex", ["--version"], root, { timeoutMs: 10_000, env: codexProcessEnv() });
  const version = result.ok ? result.output.trim().split(/\r?\n/)[0]?.trim() || null : null;
  return {
    installed: result.ok,
    available: result.ok,
    version,
    message: result.ok ? "Codex CLI is available for local project execution." : "Codex CLI is missing or unavailable.",
  };
}

function qaFailureSummary(project: Record<string, unknown>): string {
  const checklist = parseQaChecklist(project.localQaChecklist) ?? [];
  const failed = checklist.filter((item) => item.status === "failed");
  if (!failed.length) return rowString(project.localBuildError) || "No QA failure checklist is recorded.";
  return failed.map((item) => `- ${item.label}: ${item.detail}`).join("\n");
}

function buildCodexImprovementPrompt(params: {
  projectName: string;
  userRequest: string;
  researchBrief: string;
  knowledgeContext: string;
  designReview: string;
  polishReview: string;
  qaFailures: string;
  pageSummary: string;
  improvementGoal: string;
}): string {
  return [
    "You are Codex CLI running as the Hermes Local Builder improvement executor.",
    "",
    "Hard constraints:",
    "- Work only in this selected local app folder.",
    "- Do not modify files outside this folder.",
    "- Do not read, create, edit, or print .env files, API keys, tokens, credentials, private keys, or secrets.",
    "- Do not deploy, push, commit, or change production behavior.",
    "- Improve the existing Next.js app; do not replace it with a generic landing page.",
    "- Preserve working build scripts and keep the app self-contained.",
    "",
    "Original user request:",
    params.userRequest || "No original request recorded.",
    "",
    "Product brief / Athena research brief:",
    params.researchBrief || "No Athena brief recorded.",
    "",
    "Builder knowledge cards:",
    params.knowledgeContext || "No Builder knowledge cards loaded.",
    "",
    "Fugu design review:",
    params.designReview || "No Fugu design review recorded.",
    "",
    "Fugu polish review:",
    params.polishReview || "No Fugu polish review recorded.",
    "",
    "QA checklist failure reasons:",
    params.qaFailures || "No QA failures recorded.",
    "",
    "Exact improvement goal:",
    params.improvementGoal,
    "",
    "Current app summary:",
    params.pageSummary,
    "",
    "After editing, run npm run build if practical and fix any build errors. Leave a concise summary in your final response listing files changed and behavior added.",
  ].join("\n");
}

export async function buildHermesAgentExecutionPrompt(userId: string, projectId: string, userRequest: string): Promise<{ projectName: string; folder: string; prompt: string; qaChecklist: string; requiresNextContract: boolean; appType: string; questions: string[]; cardsLoaded: string[] }> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder } = await resolveProjectFolder(project);
  const effectiveRequest = rowString(project.latestInstruction) || userRequest;
  const analysis = parseLocalBuildRequest(effectiveRequest) ?? { projectName, folderName: projectName, ...classifyAppType(effectiveRequest), questions: [] };
  const knowledgeContext = await loadBuilderKnowledgeContext(projectName, effectiveRequest);
  const cardsLoaded = knowledgeContext.split(/\r?\n/).map((line) => line.match(/^- ([^:]+):/)?.[1]).filter((value): value is string => Boolean(value));
  const shellFolder = folder.replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
  const checklist = parseQaChecklist(project.localQaChecklist) ?? [];
  const qaChecklist = checklist.length
    ? checklist.map((item) => `- [${item.status}] ${item.label}: ${item.detail}`).join("\n")
    : [
      "- npm run build passes",
      "- Requested content and interactions are present",
      "- Layout works on mobile and desktop",
      "- Buttons and links have working behavior",
      "- Accessibility labels, focus states, and contrast are reasonable",
    ].join("\n");
  const explicitAlternateFramework = /\b(?:using|with|as)\s+(?:a\s+)?(?:vite|create react app|cra|plain html|astro|remix|svelte|vue)\b/i.test(userRequest);
  const requiresNextContract = !explicitAlternateFramework;

  return {
    projectName,
    folder,
    qaChecklist,
    requiresNextContract,
    appType: analysis.appType,
    questions: analysis.questions,
    cardsLoaded,
    prompt: [
      "You are Nous Research Hermes Agent acting only as Parawi's coding executor.",
      "Parawi is the orchestrator. Follow this execution packet exactly and do not broaden scope.",
      "",
      "Hard safety constraints:",
      `- Work only inside this project folder: ${shellFolder}`,
      `- Your terminal uses Git Bash. Its exact project path is: ${shellFolder}`,
      `- If a command needs an explicit directory, use cd "${shellFolder}". Never pass the Windows backslash path to bash.`,
      "- The worker has already set this project as your terminal working directory. Prefer relative paths from `.`.",
      "- Never read, create, edit, rename, delete, or print any .env file or secret.",
      "- Never access the parent HermesProject folder or the main Parawi repository.",
      "- Never commit, push, deploy, or use Git remotes.",
      "- Never delete a folder.",
      "- Run commands only with this project folder as the working directory.",
      "- Create or edit only files needed for this build.",
      "",
      "Parawi Local App Contract:",
      ...(requiresNextContract ? [
        "- Build a Next.js App Router application only.",
        "- Use TypeScript.",
        "- Required files: src/app/page.tsx, src/app/layout.tsx, src/app/globals.css.",
        "- package.json must depend on next, react, and react-dom and define `build` as `next build`.",
        "- npm run build must pass before completion.",
        "- Do not create Vite, Create React App, plain-HTML, or other framework scaffolding.",
        "- Do not create vite.config.*, root index.html, src/main.*, or react-scripts configuration.",
        "- If an incompatible scaffold already exists, replace its app files with this Next.js App Router contract without deleting folders.",
      ] : [
        "- The user explicitly requested a non-default framework; honor that request while keeping all safety constraints.",
      ]),
      "",
      "User request:",
      userRequest || rowString(project.latestInstruction) || "No request recorded.",
      "",
      "Builder plan / research brief:",
      rowString(project.localResearchBrief) || "No Builder plan recorded.",
      "",
      "Knowledge Cards:",
      knowledgeContext || "No relevant Knowledge Cards loaded.",
      "",
      "Fugu review:",
      rowString(project.localDesignReview) || "No Fugu review recorded.",
      rowString(project.localPolishReview) || "No Fugu polish review recorded.",
      "",
      "QA checklist:",
      qaChecklist,
      "",
      "Project folder:",
      shellFolder,
      "",
      requiresNextContract
        ? "Implement the request under the Parawi Local App Contract. Do not push or deploy. Finish with a concise summary of files changed."
        : "Implement the explicitly requested framework. Do not push or deploy. Finish with a concise summary of files changed.",
    ].join("\n"),
  };
}

function qaItem(key: string, label: string, passed: boolean, detail: string): LocalBuilderQaItem {
  return { key, label, status: passed ? "passed" : "failed", detail };
}

function skippedQaItem(key: string, label: string, detail: string): LocalBuilderQaItem {
  return { key, label, status: "skipped", detail };
}

function stripJsxExpressions(value: string): string {
  return value.replace(/\{[\s\S]*?\}/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function hasAccessibleButtonLabels(page: string): { passed: boolean; detail: string } {
  const buttons = [...page.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  const roleButtons = [...page.matchAll(/<[^>]+\brole=["']button["'][^>]*>/gi)];
  const unnamed = buttons.filter((match) => {
    const attrs = match[1] ?? "";
    const content = stripJsxExpressions(match[2] ?? "");
    return !content && !/\b(aria-label|aria-labelledby|title)=["'][^"']+["']/i.test(attrs);
  });
  const unnamedRoleButtons = roleButtons.filter((match) => !/\b(aria-label|aria-labelledby|title)=["'][^"']+["']/i.test(match[0]));
  const passed = unnamed.length === 0 && unnamedRoleButtons.length === 0;
  const total = buttons.length + roleButtons.length;
  return {
    passed,
    detail: passed
      ? `${total} button control(s) have visible text or accessible names.`
      : `${unnamed.length + unnamedRoleButtons.length} button control(s) lack an accessible name.`,
  };
}

function hasFormLabels(page: string): { passed: boolean; detail: string; skipped: boolean } {
  const fields = [...page.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].filter((match) => !/\btype=["'](?:hidden|submit|button)["']/i.test(match[2] ?? ""));
  if (!fields.length && !/<form\b/i.test(page)) return { passed: true, skipped: true, detail: "No forms or editable fields detected." };
  const labels = [...page.matchAll(/<label\b[^>]*\bhtmlFor=["']([^"']+)["']/gi)].map((match) => match[1]);
  const labelSet = new Set(labels);
  const unlabeled = fields.filter((match) => {
    const attrs = match[2] ?? "";
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1];
    return !/\b(aria-label|aria-labelledby)=["'][^"']+["']/i.test(attrs) && (!id || !labelSet.has(id));
  });
  return {
    passed: unlabeled.length === 0,
    skipped: false,
    detail: unlabeled.length === 0
      ? `${fields.length} form field(s) have label, aria-label, or aria-labelledby coverage.`
      : `${unlabeled.length} form field(s) are missing labels.`,
  };
}

function hasKeyboardSafeInteractions(page: string): { passed: boolean; detail: string } {
  const clickableNonControls = [...page.matchAll(/<(div|span|li|article|section)\b(?=[^>]*\bonClick=)([^>]*)>/gi)];
  const unsafe = clickableNonControls.filter((match) => !/\brole=["']button["']|\btabIndex=|\bonKey(?:Down|Up|Press)=/i.test(match[2] ?? ""));
  return {
    passed: unsafe.length === 0,
    detail: unsafe.length === 0
      ? "No mouse-only non-semantic clickable elements were found."
      : `${unsafe.length} clickable non-control element(s) need a button/link element or keyboard handlers with tabIndex.`,
  };
}

function hasSemanticStructure(page: string): { passed: boolean; detail: string } {
  const hasMain = /<main\b/i.test(page);
  const headings = page.match(/<h[1-6]\b/gi) ?? [];
  const hasSectioning = /<(section|article|nav|header|footer|aside)\b/i.test(page);
  const passed = hasMain && headings.length > 0 && hasSectioning;
  return {
    passed,
    detail: passed
      ? "Page includes a main landmark, headings, and sectioning structure."
      : "Page needs a main landmark, useful headings, and semantic sectioning elements.",
  };
}

function hasFocusStyles(css: string): { passed: boolean; detail: string } {
  const passed = /:focus-visible|:focus/i.test(css);
  return {
    passed,
    detail: passed ? "CSS includes focus or focus-visible styling." : "CSS is missing visible focus styles for keyboard users.",
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.replace("#", "").trim();
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(normalized)) return null;
  const full = normalized.length === 3 ? normalized.split("").map((c) => c + c).join("") : normalized;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const values = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hasReadableContrast(css: string): { passed: boolean; detail: string } {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const failures: string[] = [];
  for (const block of blocks) {
    const selector = block[1].trim();
    const body = block[2];
    const color = body.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
    const background = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
    if (!color || !background) continue;
    const ratio = contrastRatio(color, background);
    if (ratio !== null && ratio < 4.5) failures.push(`${selector} ${ratio.toFixed(2)}:1`);
  }
  return {
    passed: failures.length === 0,
    detail: failures.length === 0
      ? "No obvious static foreground/background contrast failures were found."
      : `Potential contrast failures below 4.5:1: ${failures.slice(0, 4).join(", ")}.`,
  };
}

async function evaluateLocalBuilderQa(project: Record<string, unknown>, folder: string): Promise<{ status: "qa_passed" | "qa_failed"; checklist: LocalBuilderQaItem[]; summary: string }> {
  const { page, css, plan } = await readGeneratedAppFiles(folder);
  const buildLog = rowString(project.localBuildLog);
  const projectStatus = rowString(project.status);
  const dependencyInstallExists = await exists(path.join(folder, "node_modules"));
  const hasBuildPassed = /Building:\s*passed|Rebuild:\s*passed/i.test(buildLog)
    || ["Build Passed", "qa_pending", "qa_failed", "qa_passed", "completed"].includes(projectStatus);
  const hasInstallPassed = /Installing:\s*passed/i.test(buildLog)
    || /Rebuild:\s*passed/i.test(buildLog)
    || dependencyInstallExists
    || hasBuildPassed;
  const hasHomepage = page.trim().length > 0 && /export\s+default\s+function|export\s+default\s+async\s+function/.test(page);
  const hasNavigation = /href=["'](?!#["'])[^"']+["']/.test(page) || /id=["'][^"']+["']/.test(page) || /router\.push|next\/link|<Link\b/.test(page);
  const buttonMatches = page.match(/<button\b|role=["']button["']|<a\s+[^>]*href=/g) ?? [];
  const buttonHandlerMatches = page.match(/onClick=|href=["'](?!#["'])[^"']+["']/g) ?? [];
  const hasPrimaryButtons = buttonMatches.length > 0 && buttonHandlerMatches.length > 0;
  const interactionSignals = /useState|onChange=|onSubmit=|onClick=|filter\(|set[A-Z]\w*\(|<form\b|localStorage/.test(page);
  const appPromisesInteraction = /filter|form|interaction|button|save|compare|search|status|localStorage/i.test(`${page}\n${plan}`);
  const usesLocalStorage = /localStorage/.test(page);
  const localStorageSafe = !usesLocalStorage || /typeof\s+window|useEffect|try\s*\{/.test(page);
  const mobileReviewed = /@media\s*\(|grid-template-columns:\s*1fr|max-width:\s*\d+px|clamp\(/i.test(css);
  const deadHints = [
    /href=["']#["']/,
    /onClick=\{\(\)\s*=>\s*\{\s*\}\}/,
    /TODO|coming soon|placeholder|lorem ipsum/i,
  ];
  const noDeadSections = !deadHints.some((pattern) => pattern.test(`${page}\n${css}`));
  const designReview = rowString(project.localDesignReview);
  const polishReview = rowString(project.localPolishReview);
  const designScore = rowNumber(project.designScore);
  const semantic = hasSemanticStructure(page);
  const buttonLabels = hasAccessibleButtonLabels(page);
  const formLabels = hasFormLabels(page);
  const keyboard = hasKeyboardSafeInteractions(page);
  const focusStyles = hasFocusStyles(css);
  const contrast = hasReadableContrast(css);

  const checklist: LocalBuilderQaItem[] = [
    qaItem("npm_install_completed", "npm install completed", hasInstallPassed, hasInstallPassed ? "Install step completed successfully." : "Install success was not recorded in the build log."),
    qaItem("npm_build_passed", "npm run build passed", hasBuildPassed, hasBuildPassed ? "Production build completed successfully." : "Production build success was not recorded."),
    qaItem("homepage_loads", "homepage loads", hasHomepage, hasHomepage ? "src/app/page.tsx exists and exports a page component." : "No valid homepage component was found."),
    qaItem("navigation_works", "navigation works", hasNavigation, hasNavigation ? "Navigation anchors, ids, router usage, or Link usage were found." : "No meaningful navigation target was found."),
    qaItem("primary_buttons_clickable", "primary buttons are clickable", hasPrimaryButtons, hasPrimaryButtons ? `${buttonMatches.length} button/link control(s) with handler or href found.` : "Primary controls are missing or appear inert."),
    qaItem("semantic_html", "semantic HTML landmarks and headings", semantic.passed, semantic.detail),
    qaItem("button_accessible_names", "buttons have accessible names", buttonLabels.passed, buttonLabels.detail),
    formLabels.skipped
      ? skippedQaItem("form_labels", "form labels are present when forms exist", formLabels.detail)
      : qaItem("form_labels", "form labels are present when forms exist", formLabels.passed, formLabels.detail),
    qaItem("keyboard_navigation", "keyboard navigation is not mouse-only", keyboard.passed, keyboard.detail),
    qaItem("focus_states", "visible focus states exist", focusStyles.passed, focusStyles.detail),
    qaItem("contrast", "static contrast meets WCAG AA where detectable", contrast.passed, contrast.detail),
    appPromisesInteraction
      ? qaItem("interactions_work", "filters/forms/interactions work if present", interactionSignals, interactionSignals ? "Stateful controls or form/filter handlers were found." : "The app appears to promise interaction but no handlers/state were found.")
      : skippedQaItem("interactions_work", "filters/forms/interactions work if present", "No filters/forms/stateful interactions detected."),
    usesLocalStorage
      ? qaItem("local_storage_works", "localStorage works if used", localStorageSafe, localStorageSafe ? "localStorage usage appears guarded for client runtime." : "localStorage usage may be unsafe or unguarded.")
      : skippedQaItem("local_storage_works", "localStorage works if used", "localStorage is not used."),
    qaItem("mobile_layout_reviewed", "mobile layout reviewed", mobileReviewed, mobileReviewed ? "Responsive CSS cues were found." : "No obvious responsive/mobile CSS was found."),
    qaItem("no_empty_dead_sections", "no obvious empty/dead sections", noDeadSections, noDeadSections ? "No obvious placeholders, dead hrefs, or empty handlers detected." : "Potential placeholder/dead-section hints were found."),
    designReview
      ? qaItem("design_review_score_recorded", "design review score recorded if Fugu is available", typeof designScore === "number", typeof designScore === "number" ? `Design review score recorded: ${designScore}/10.` : "Design review exists but no numeric score was recorded.")
      : skippedQaItem("design_review_score_recorded", "design review score recorded if Fugu is available", "No Fugu design review is attached."),
    qaItem("polish_review_completed", "polish review completed", Boolean(polishReview), polishReview ? "Post-build polish review is attached." : "Run Fugu Design Review after generation to record polish guidance."),
  ];

  const failed = checklist.filter((item) => item.status === "failed");
  const summary = failed.length
    ? `QA review pending: ${failed.map((item) => item.label).join(", ")}.`
    : "QA passed: build, interaction, responsive, and polish gates are satisfied.";

  return {
    status: failed.length ? "qa_failed" : "qa_passed",
    checklist,
    summary,
  };
}

async function upsertSkillTask(db: Db, projectId: string, userId: string, title: string, description: string, status: "pending" | "done", nextStep: string): Promise<void> {
  const existing = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, title],
  });

  if (existing.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = ?, assignedAgent = ?, description = ?, nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [status, LOCAL_BUILDER_AGENT, description.slice(0, 500), nextStep, rowString((existing.rows[0] as Record<string, unknown>).id)],
    });
    return;
  }

  await db.execute({
    sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [crypto.randomUUID(), projectId, userId, title, description.slice(0, 500), status, LOCAL_BUILDER_AGENT, nextStep],
  });
}

export async function runLocalFuguDesignReview(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const pageSummary = await summarizeGeneratedPage(folder);
  const hasGeneratedPage = pageSummary.includes("## src/app/page.tsx");
  const target: "design" | "polish" = hasGeneratedPage ? "polish" : "design";
  const status = rowString(project.status) || "Brief Ready";
  const currentLog = rowString(project.localBuildLog);
  const result = await runFuguDesignCritique({
    projectInfo: [
      `Project: ${projectName}`,
      `Status: ${status}`,
      `Folder: ${folder}`,
      `Created: ${createdAt}`,
      `Research brief present: ${rowString(project.localResearchBrief) ? "yes" : "no"}`,
      `Existing design review present: ${rowString(project.localDesignReview) ? "yes" : "no"}`,
      `Existing polish review present: ${rowString(project.localPolishReview) ? "yes" : "no"}`,
    ].join("\n"),
    pageSummary,
    buildNotes: currentLog || "No build notes yet.",
  });
  const review = result.review;
  const nextLog = `${currentLog}\nFugu Design Review: ${result.connected ? "completed" : "not connected"}${result.score ? ` (${result.score}/10)` : ""}.\n${review}`.trim();

  if (target === "polish") {
    const polishStatus = typeof result.score === "number" && result.score >= getFuguDesignPassScore() ? "pass" : result.connected ? "revise" : "unavailable";
    await db.execute({
      sql: `UPDATE Project SET localPolishReview = ?, designScore = ?, fuguPolishStatus = ?, localBuildLog = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [review, result.score, polishStatus, nextLog.slice(-12000), projectId],
    });
  } else {
    const gate = await runFuguDesignGate(fuguGateInputFromProject(projectName, rowString(project.latestInstruction), rowString(project.localResearchBrief), project));
    await persistFuguDesignGate(
      db,
      projectId,
      currentLog,
      gate,
      gate.verdict === "pass" ? "Design Ready" : gate.verdict === "revise" ? "Design Revision Needed" : gate.verdict === "unavailable" ? "Fugu Unavailable" : "Fugu Error"
    );
  }

  await logFuguRun(db, projectName, target, review);
  await upsertSkillTask(
    db,
    projectId,
    userId,
    `${target === "polish" ? "Visual polish review" : "Fugu design critique"} for ${projectName}`,
    "Read-only Fugu critique for Builder guidance. Fugu does not modify code.",
    result.connected ? "done" : "pending",
    result.connected ? "Review saved for Builder guidance" : "Add SAKANA_API_KEY to environment"
  );

  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status,
    createdAt,
    currentTask: `Run Fugu Design Review for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: nextLog.slice(-12000),
    buildError: rowString(project.localBuildError) || null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: target === "design" ? review : rowString(project.localDesignReview) || null,
    polishReview: target === "polish" ? review : rowString(project.localPolishReview) || null,
    designScore: result.score,
    ...projectGateFields(project),
    fuguPolishStatus: target === "polish"
      ? (typeof result.score === "number" && result.score >= getFuguDesignPassScore() ? "pass" : result.connected ? "revise" : "unavailable")
      : rowString(project.fuguPolishStatus) || null,
    qaStatus: rowString(project.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project.localQaChecklist),
  };
}

export async function runLocalFuguDesignGate(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  await ensureLocalBuilderColumns(db);
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const researchBrief = rowString(project.localResearchBrief) || await createAthenaResearchBrief(projectName, rowString(project.latestInstruction) || projectName);
  if (!rowString(project.localResearchBrief)) {
    await db.execute({
      sql: `UPDATE Project SET localResearchBrief = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [researchBrief, projectId],
    });
  }
  const gate = await runFuguDesignGate(fuguGateInputFromProject(projectName, rowString(project.latestInstruction), researchBrief, project));
  const status = gate.verdict === "pass"
    ? "Design Ready"
    : gate.verdict === "revise"
      ? "Design Revision Needed"
      : gate.verdict === "unavailable"
        ? "Fugu Unavailable"
        : "Fugu Error";
  const nextLog = await persistFuguDesignGate(db, projectId, rowString(project.localBuildLog), gate, status);

  await upsertSkillTask(
    db,
    projectId,
    userId,
    `Fugu design gate for ${projectName}`,
    "Read-only pre-build Fugu gate for design direction, UX completeness, and Builder constraints.",
    gate.verdict === "pass" ? "done" : "pending",
    gate.verdict === "pass" ? "Design gate passed; normal build is allowed" : "Review Fugu feedback or record an explicit override"
  );
  await logFuguRun(db, projectName, "design", formatFuguDesignGate(gate));

  const updated = {
    ...project,
    status,
    localResearchBrief: researchBrief,
    localDesignReview: formatFuguDesignGate(gate),
    designScore: gate.score,
    fuguGateStatus: gate.verdict,
    fuguGateScore: gate.score,
    fuguGateReview: JSON.stringify(gate),
    fuguGateReviewedAt: gate.reviewedAt,
    localBuildLog: nextLog,
  };

  return fuguGateProjectResult(
    updated,
    projectId,
    projectName,
    folder,
    createdAt,
    `Run Fugu Design Gate for ${projectName}`,
    crypto.randomUUID()
  );
}

export async function overrideFuguDesignGate(userId: string, projectId: string, reason: string): Promise<LocalBuildProject> {
  const trimmed = reason.trim();
  if (trimmed.length < 12) throw new Error("Fugu override requires a specific reason.");
  const db = getDb();
  await ensureLocalBuilderColumns(db);
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const nextLog = `${rowString(project.localBuildLog)}\nFugu Gate Override: ${trimmed}`.trim().slice(-12000);
  await db.execute({
    sql: `UPDATE Project SET status = 'Design Ready', fuguGateOverrideReason = ?, localBuildLog = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
    args: [trimmed.slice(0, 1000), nextLog, projectId, userId],
  });
  const updated = { ...project, status: "Design Ready", fuguGateOverrideReason: trimmed, localBuildLog: nextLog };
  return fuguGateProjectResult(updated, projectId, projectName, folder, createdAt, `Override Fugu gate for ${projectName}`, crypto.randomUUID());
}

export async function prepareLocalBuildProject(userId: string, message: string): Promise<LocalBuildProject | null> {
  const parsed = parseLocalBuildRequest(message);
  if (!parsed) return null;
  if (parsed.questions.length) {
    throw new Error(`Clarification required before building ${parsed.projectName}: ${parsed.questions.join(" ")}`);
  }

  const root = await getLocalProjectsRoot();
  if (!(await exists(root))) {
    throw new Error(`Local builder root folder is missing: ${root}`);
  }

  const localFolderPath = path.resolve(root, parsed.folderName);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (localFolderPath !== root && !localFolderPath.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }
  await mkdir(localFolderPath, { recursive: true });

  const db = getDb();
  await ensureLocalBuilderColumns(db);
  const researchBrief = await createAthenaResearchBrief(parsed.projectName, message);

  const now = new Date().toISOString();
  const existing = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? AND (lower(projectName) = lower(?) OR localFolderPath = ?) LIMIT 1`,
    args: [userId, parsed.projectName, localFolderPath],
  });

  let projectId: string;
  let createdAt = now;

  if (existing.rows.length) {
    const row = existing.rows[0] as Record<string, unknown>;
    projectId = rowString(row.id);
    createdAt = rowString(row.createdAt) || now;
    await db.execute({
      sql: `UPDATE Project SET projectName = ?, status = 'Researching', latestInstruction = ?, assignedAgent = ?, localFolderPath = ?, localBuildLog = ?, localBuildError = NULL, localDesignReview = NULL, localPolishReview = NULL, designScore = NULL, fuguGateStatus = NULL, fuguGateScore = NULL, fuguGateReview = NULL, fuguGateReviewedAt = NULL, fuguGateOverrideReason = NULL, fuguPolishStatus = NULL, updatedAt = datetime('now') WHERE id = ?`,
      args: [parsed.projectName, message.slice(0, 500), ATHENA_RESEARCH_AGENT, localFolderPath, "Researching: Athena is creating a build brief.\n", projectId],
    });
  } else {
    projectId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, localFolderPath, localBuildLog, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'Researching', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [projectId, userId, parsed.projectName, null, message.slice(0, 500), ATHENA_RESEARCH_AGENT, localFolderPath, "Researching: Athena is creating a build brief.\n"],
    });
  }

  const researchTask = `Athena research brief for ${parsed.projectName}`;
  const researchTaskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, researchTask],
  });

  if (researchTaskExisting.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'done', assignedAgent = ?, nextStep = 'Brief ready for Builder generation', updatedAt = datetime('now') WHERE id = ?`,
      args: [ATHENA_RESEARCH_AGENT, rowString((researchTaskExisting.rows[0] as Record<string, unknown>).id)],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'done', ?, 'Brief ready for Builder generation', datetime('now'))`,
      args: [crypto.randomUUID(), projectId, userId, researchTask, researchBrief.slice(0, 500), ATHENA_RESEARCH_AGENT],
    });
  }

  await db.execute({
    sql: `UPDATE Project SET status = 'Brief Ready', assignedAgent = ?, localResearchBrief = ?, localDesignReview = NULL, designScore = NULL, fuguGateStatus = NULL, fuguGateScore = NULL, fuguGateReview = NULL, fuguGateReviewedAt = NULL, fuguGateOverrideReason = NULL, fuguPolishStatus = NULL, localBuildLog = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [LOCAL_BUILDER_AGENT, researchBrief, `Researching: Athena created an internal build brief.\nBrief Ready: Builder can generate from the research brief. Fugu Design Gate runs before normal build.\n\n${researchBrief}`, projectId],
  });

  await logAthenaResearchRun(db, parsed.projectName, researchBrief);

  const skillTasks = [
    ["Product brief", "Define audience, business goal, pages, features, tone, and content needs."],
    ["Design brief", "Define visual direction, typography, spacing, layout, motion, and asset rules."],
    ["Feature plan", "Define catalog, cards, filters, detail views, saved/compare, and checkout or concierge flow."],
    ["Build plan", "Define implementation steps for responsive, stateful, testable UI."],
    ["Fugu design gate", "Read-only pre-build review for UX structure, visual direction, missing interactions, realism, and required improvements."],
    ["QA checklist", "Verify build, navigation, buttons, filters, localStorage, responsive layout, and no copied assets."],
    ["Visual polish review", "Confirm the app feels like a real product before completion."],
  ] as const;

  for (const [title, description] of skillTasks) {
    await upsertSkillTask(db, projectId, userId, `${title} for ${parsed.projectName}`, description, title === "Visual polish review" ? "pending" : "done", title === "Visual polish review" ? "Review after generation and QA" : "Ready for Builder generation");
  }

  const currentTask = `Generate app from Athena brief for ${parsed.projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, currentTask],
  });

  let taskId: string;
  if (taskExisting.rows.length) {
    taskId = rowString((taskExisting.rows[0] as Record<string, unknown>).id);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', assignedAgent = ?, nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, "Generate the app using the Athena research brief", taskId],
    });
  } else {
    taskId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      args: [taskId, projectId, userId, currentTask, message.slice(0, 500), LOCAL_BUILDER_AGENT, "Generate the app using the Athena research brief"],
    });
  }

  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', 'completed', datetime('now'))`,
    args: [
      crypto.randomUUID(),
      LOCAL_BUILDER_AGENT,
      `local_build_prepare project=${parsed.projectName}`,
      `Brief Ready and prepared ${localFolderPath}`,
    ],
  }).catch(() => undefined);

  let preparedStatus = "Brief Ready";
  let preparedLog = `Researching: Athena created an internal build brief.\nBrief Ready: Builder can generate from the research brief. Fugu Design Gate runs before normal build.\n\n${researchBrief}`;
  let preparedGateFields: Pick<LocalBuildProject, "fuguGateStatus" | "fuguGateScore" | "fuguGateReview" | "fuguGateReviewedAt" | "fuguGateOverrideReason" | "fuguPolishStatus"> = {
    fuguGateStatus: null,
    fuguGateScore: null,
    fuguGateReview: null,
    fuguGateReviewedAt: null,
    fuguGateOverrideReason: null,
    fuguPolishStatus: null,
  };
  let preparedDesignReview: string | null = null;
  let preparedDesignScore: number | null = null;

  if (getFuguDesignGateMode() !== "off") {
    const gate = await runFuguDesignGate(fuguGateInputFromProject(parsed.projectName, message, researchBrief));
    preparedStatus = gate.verdict === "pass"
      ? "Design Ready"
      : gate.verdict === "revise"
        ? "Design Revision Needed"
        : gate.verdict === "unavailable"
          ? "Fugu Unavailable"
          : "Fugu Error";
    preparedLog = await persistFuguDesignGate(db, projectId, preparedLog, gate, preparedStatus);
    preparedDesignReview = formatFuguDesignGate(gate);
    preparedDesignScore = gate.score;
    preparedGateFields = {
      fuguGateStatus: gate.verdict,
      fuguGateScore: gate.score,
      fuguGateReview: gate,
      fuguGateReviewedAt: gate.reviewedAt,
      fuguGateOverrideReason: null,
      fuguPolishStatus: null,
    };
  }

  return {
    id: projectId,
    projectName: parsed.projectName,
    localFolderPath,
    status: preparedStatus,
    createdAt,
    currentTask,
    taskId,
    buildLog: preparedLog,
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
    researchBrief,
    designReview: preparedDesignReview,
    polishReview: null,
    designScore: preparedDesignScore,
    ...preparedGateFields,
    qaStatus: null,
    qaChecklist: null,
  };
}

export async function queueLocalBuilderWorkerTask(
  userId: string,
  action: string,
  message: string,
  projectId?: string,
  assignedExecutor: "local_worker" | "hermes_agent" = "local_worker"
): Promise<LocalBuildProject | null> {
  const db = getDb();
  await ensureLocalBuilderColumns(db);

  const now = new Date().toISOString();
  let project: Record<string, unknown> | null = null;
  let resolvedProjectId = projectId ?? "";
  let projectName = "Local Builder project";
  let localFolderPath = joinLocalProjectPath(await getLocalProjectsRoot(), "queued-local-build");
  let createdAt = now;

  if (resolvedProjectId) {
    const existing = await findLocalBuildProject(db, userId, resolvedProjectId);
    project = existing;
    projectName = rowString(existing.projectName) || projectName;
    localFolderPath = rowString(existing.localFolderPath) || localFolderPath;
    createdAt = rowString(existing.createdAt) || now;
  } else {
    const parsed = parseLocalBuildRequest(message);
    if (!parsed) return null;
    if (parsed.questions.length) {
      throw new Error(`Clarification required before building ${parsed.projectName}: ${parsed.questions.join(" ")}`);
    }
    projectName = parsed.projectName;
    localFolderPath = joinLocalProjectPath(await getLocalProjectsRoot(), parsed.folderName);

    const existing = await db.execute({
      sql: `SELECT * FROM Project WHERE userId = ? AND (lower(projectName) = lower(?) OR localFolderPath = ?) LIMIT 1`,
      args: [userId, projectName, localFolderPath],
    });

    if (existing.rows.length) {
      project = existing.rows[0] as Record<string, unknown>;
      resolvedProjectId = rowString(project.id);
      createdAt = rowString(project.createdAt) || now;
    } else {
      resolvedProjectId = crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, localFolderPath, localBuildLog, localBuildError, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'queued_for_local_worker', ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))`,
        args: [
          resolvedProjectId,
          userId,
          projectName,
          null,
          message.slice(0, 500),
          LOCAL_BUILDER_AGENT,
          localFolderPath,
          "Queued for local worker. Serverless runtime did not touch the local filesystem.\n",
        ],
      });
    }
  }

  if (project && ["generate", "rebuild", "build", "npmBuild", "runCodex"].includes(action)) {
    const gate = canStartBuildWithFuguGate(project);
    if (!gate.allowed) throw new Error(gate.reason);
  }

  const task = await createExecutionQueueTask({
    userId,
    title: `${queuedActionLabel(action)} for ${projectName}`,
    description: [
      `Action: ${action}`,
      `Project: ${projectName}`,
      `Local folder: ${localFolderPath}`,
      message ? `Message: ${message}` : null,
      "Run this from the local worker; serverless runtime must not execute local filesystem or process actions.",
    ].filter(Boolean).join("\n").slice(0, 2000),
    priority: action === "prepare" ? "medium" : "high",
    assignedExecutor,
    projectId: resolvedProjectId,
    initialLog: `route=local_worker_queue executor=${assignedExecutor} reason=serverless_cannot_write_local_files. Queued for local execution.`,
  });
  await import("@/lib/execution-runs").then(({ createExecutionRun }) => createExecutionRun({
    userId,
    projectId: resolvedProjectId,
    taskId: task.id,
    executor: assignedExecutor,
    currentPhase: "queued",
    currentActivity: `${queuedActionLabel(action)} queued for ${projectName}.`,
    localFolderPath,
  })).catch(() => undefined);

  const log = `${rowString(project?.localBuildLog) || ""}\nQueued ${action} for local worker task ${task.id}.\nServerless runtime did not touch ${localFolderPath}.`.trim();
  await db.execute({
    sql: `UPDATE Project SET status = 'queued_for_local_worker', latestInstruction = ?, assignedAgent = ?, localFolderPath = ?, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
    args: [message.slice(0, 500), assignedExecutor, localFolderPath, log.slice(-12000), resolvedProjectId, userId],
  });

  const currentTask = `${queuedActionLabel(action)} for ${projectName}`;
  await db.execute({
    sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
    args: [
      crypto.randomUUID(),
      resolvedProjectId,
      userId,
      currentTask,
      `Queued for local worker task ${task.id}`,
      assignedExecutor,
      `Local worker should claim and launch ${assignedExecutor}.`,
    ],
  }).catch(() => undefined);

  await logLocalBuilderRun(db, "queued", `local_build_queued action=${action} project=${projectName}`, `Queued local worker task ${task.id}: ${localFolderPath}`);

  return {
    id: resolvedProjectId,
    projectName,
    localFolderPath,
    status: "queued_for_local_worker",
    createdAt,
    currentTask,
    taskId: task.id,
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: rowString(project?.localDevUrl) || null,
    localDevPid: typeof project?.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project?.localResearchBrief) || null,
    designReview: rowString(project?.localDesignReview) || null,
    polishReview: rowString(project?.localPolishReview) || null,
    designScore: rowNumber(project?.designScore),
    ...(project ? projectGateFields(project) : {}),
    qaStatus: rowString(project?.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project?.localQaChecklist),
  };
}

export async function generateLocalStarterApp(userId: string, projectId: string, message: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const gate = canStartBuildWithFuguGate(project);
  if (!gate.allowed) throw new Error(gate.reason);
  const { projectName, folder: resolvedFolder, createdAt } = await resolveProjectFolder(project);
  const researchBrief = rowString(project.localResearchBrief) || await createAthenaResearchBrief(projectName, message);
  const builderKnowledge = await loadBuilderKnowledgeContext(projectName, message);
  const designReview = rowString(project.localDesignReview);
  if (!rowString(project.localResearchBrief)) {
    await db.execute({
      sql: `UPDATE Project SET localResearchBrief = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [researchBrief, projectId],
    });
  }

  const taskTitle = `Generate starter app for ${projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, taskTitle],
  });
  const taskId = taskExisting.rows.length ? rowString((taskExisting.rows[0] as Record<string, unknown>).id) : crypto.randomUUID();
  if (taskExisting.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'in_progress', assignedAgent = ?, nextStep = 'Generate starter app files', updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, taskId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, 'Generate starter app files', datetime('now'))`,
      args: [taskId, projectId, userId, taskTitle, message.slice(0, 500), LOCAL_BUILDER_AGENT],
    });
  }

  let log = `${rowString(project.localBuildLog) || "Ready to Build"}\n`;
  log += designReview
    ? `Builder: using saved Fugu design review${rowNumber(project.designScore) ? ` with score ${rowNumber(project.designScore)}/10` : ""}.\n`
    : "Builder: no Fugu design review attached; generating from the Athena brief.\n";
  log += `Builder: loaded knowledge cards.\n${builderKnowledge}\n`;
  const files = await appFiles(projectName, message, researchBrief, designReview, builderKnowledge);
  const changedFiles = Object.keys(files);

  try {
    await updateProjectBuildState(db, projectId, "Generating", log);
    await mkdir(resolvedFolder, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedFolder, ...relativePath.split("/"));
      const folderWithSep = resolvedFolder.endsWith(path.sep) ? resolvedFolder : `${resolvedFolder}${path.sep}`;
      if (absolutePath !== resolvedFolder && !absolutePath.startsWith(folderWithSep)) {
        throw new Error(`Unsafe generated file path rejected: ${relativePath}`);
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
    log += `Generating: wrote ${changedFiles.join(", ")}\n`;

    await updateProjectBuildState(db, projectId, "Installing", log);
    const install = await run("npm", ["install"], resolvedFolder);
    log += `\nInstalling: ${install.ok ? "passed" : "failed"}\n${install.output}\n`;
    if (!install.ok) throw new Error(`npm install failed\n${install.output}`);

    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], resolvedFolder, "production");
    log += `\nBuilding: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);

    log += "\nQA: build passed; checklist pending.\n";
    await updateProjectBuildState(db, projectId, "qa_pending", log);
    await db.execute({
      sql: `UPDATE Project SET localQaStatus = 'qa_pending', localQaChecklist = NULL, updatedAt = datetime('now') WHERE id = ?`,
      args: [projectId],
    });
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'in_progress', nextStep = 'Run QA checklist before completion', updatedAt = datetime('now') WHERE id = ?`,
      args: [taskId],
    });
    await upsertSkillTask(db, projectId, userId, `Visual polish review for ${projectName}`, "Confirm the app feels like a real product before completion.", "pending", "Run Fugu Design Review if the generated app feels too basic");
    await logLocalBuilderRun(db, "completed", `local_build_generate project=${projectName}`, `Build passed; QA pending: ${resolvedFolder}`);

    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "qa_pending",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief,
      designReview: designReview || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: "qa_pending",
      qaChecklist: null,
      files: changedFiles,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await db.execute({
      sql: `UPDATE Project SET localQaStatus = 'qa_failed', updatedAt = datetime('now') WHERE id = ?`,
      args: [projectId],
    }).catch(() => undefined);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [`Fix first build error: ${detail.slice(0, 300)}`, taskId],
    }).catch(() => undefined);
    await logLocalBuilderRun(db, "failed", `local_build_generate project=${projectName}`, detail.slice(0, 2000));
    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "Build Failed",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief,
      designReview: designReview || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: "qa_failed",
      qaChecklist: parseQaChecklist(project.localQaChecklist),
      files: changedFiles,
    };
  }
}

export async function runLocalBuilderQa(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  let log = `${rowString(project.localBuildLog)}\nQA: checklist started.\n`.trim();

  await db.execute({
    sql: `UPDATE Project SET status = 'qa_running', localQaStatus = 'qa_running', localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [log.slice(-12000), projectId],
  });

  const qa = await evaluateLocalBuilderQa(project, folder);
  log += `\nQA: ${qa.summary}\n`;
  for (const item of qa.checklist) {
    log += `- [${item.status}] ${item.label}: ${item.detail}\n`;
  }

  const passed = qa.status === "qa_passed";
  const finalStatus = passed ? "completed" : "qa_pending";
  const displayedQaStatus = passed ? "qa_passed" : "qa_pending";
  await db.execute({
    sql: `UPDATE Project SET status = ?, localQaStatus = ?, localQaChecklist = ?, localBuildLog = ?, localBuildError = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [finalStatus, displayedQaStatus, JSON.stringify(qa.checklist), log.slice(-12000), null, projectId],
  });

  await db.execute({
    sql: `UPDATE ProjectTask SET status = ?, nextStep = ?, updatedAt = datetime('now') WHERE projectId = ? AND title LIKE ?`,
    args: [passed ? "done" : "in_progress", passed ? "QA passed; local build completed" : qa.summary.slice(0, 300), projectId, `Generate starter app for ${projectName}`],
  }).catch(() => undefined);

  await upsertSkillTask(
    db,
    projectId,
    userId,
    `QA checklist for ${projectName}`,
    "Verify build, homepage, navigation, buttons, keyboard access, labels, contrast, focus states, interactions, mobile layout, dead sections, and polish review.",
    passed ? "done" : "pending",
    passed ? "Local builder QA passed" : qa.summary
  );
  await logLocalBuilderRun(db, passed ? "completed" : "failed", `local_build_qa project=${projectName}`, qa.summary);

  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: finalStatus,
    createdAt,
    currentTask: `QA checklist for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: rowString(project.localDesignReview) || null,
    polishReview: rowString(project.localPolishReview) || null,
    designScore: rowNumber(project.designScore),
    qaStatus: displayedQaStatus,
    qaChecklist: qa.checklist,
  };
}

export async function runLocalCodexExecutor(userId: string, projectId: string, improvementPrompt: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const gate = canStartBuildWithFuguGate(project);
  if (!gate.allowed) throw new Error(gate.reason);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const root = path.resolve(await getLocalProjectsRoot());
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (folder === root || !folder.startsWith(rootWithSep)) {
    throw new Error("Codex CLI executor refused to run outside an approved HermesProject app folder.");
  }

  const codexStatus = await getCodexCliStatus();
  const queueTask = await createExecutionQueueTask({
    userId,
    title: `Improve ${projectName} with Codex CLI`,
    description: improvementPrompt.slice(0, 2000),
    priority: "high",
    assignedExecutor: CODEX_CLI_EXECUTOR,
    projectId,
    initialLog: "Queued Codex CLI local app improvement.",
  });

  let log = `${rowString(project.localBuildLog)}\nCodex CLI: queued executor task ${queueTask.id}.\n`.trim();
  if (!codexStatus.available) {
    const message = "Codex CLI is missing or unavailable.";
    await updateExecutionQueueTask(userId, queueTask.id, { status: "failed", error: message, log: message });
    await updateProjectBuildState(db, projectId, "failed", log, message);
    throw new Error(message);
  }

  await updateExecutionQueueTask(userId, queueTask.id, {
    status: "executing",
    log: `Running Codex CLI ${codexStatus.version ?? ""} inside ${folder}.`,
  });
  await db.execute({
    sql: `UPDATE Project SET status = 'executing', assignedAgent = ?, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [CODEX_CLI_EXECUTOR, log.slice(-12000), projectId],
  });

  const pageSummary = await summarizeGeneratedPage(folder);
  const builderKnowledge = await loadBuilderKnowledgeContext(projectName, improvementPrompt);
  const prompt = buildCodexImprovementPrompt({
    projectName,
    userRequest: rowString(project.latestInstruction),
    researchBrief: rowString(project.localResearchBrief),
    knowledgeContext: builderKnowledge,
    designReview: rowString(project.localDesignReview),
    polishReview: rowString(project.localPolishReview),
    qaFailures: qaFailureSummary(project),
    pageSummary,
    improvementGoal: improvementPrompt,
  });
  const before = await collectProjectSnapshot(folder);
  const codexModel = process.env.CODEX_CLI_MODEL?.trim() || DEFAULT_CODEX_CLI_MODEL;
  const codexArgs = [
    "-m",
    codexModel,
    "--ask-for-approval",
    "never",
    "exec",
    "--cd",
    folder,
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-",
  ];
  const codex = await runDetailed("codex", codexArgs, folder, {
    timeoutMs: 900_000,
    env: codexProcessEnv(),
    input: prompt,
    displayCommand: `codex -m ${codexModel} --ask-for-approval never exec --cd ${JSON.stringify(folder)} --skip-git-repo-check --sandbox workspace-write <structured-prompt>`,
  });
  let changedFiles = await changedFilesSince(folder, before);
  const secretFiles = await restoreSecretFileChanges(folder, before, changedFiles);
  if (secretFiles.length) changedFiles = await changedFilesSince(folder, before);

  log += [
    "",
    `Codex CLI: ${codex.ok ? "completed" : "failed"}.`,
    `Command: ${codex.command}`,
    `Exit code: ${codex.exitCode ?? "none"}`,
    `Files changed: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
    secretFiles.length ? `Secret-file safeguard restored/rejected: ${secretFiles.join(", ")}` : null,
    codex.stdout ? `stdout:\n${codex.stdout}` : null,
    codex.stderr ? `stderr:\n${codex.stderr}` : null,
  ].filter(Boolean).join("\n");

  if (!codex.ok || secretFiles.length) {
    const detail = secretFiles.length
      ? `Codex attempted to modify forbidden secret file(s): ${secretFiles.join(", ")}. Changes were restored.`
      : `Codex CLI failed with exit code ${codex.exitCode ?? "none"}. ${codex.stderr || "See local build log for captured stdout/stderr."}`;
    await updateExecutionQueueTask(userId, queueTask.id, { status: "failed", error: detail, log: detail });
    await updateProjectBuildState(db, projectId, "failed", log, detail);
    await logLocalBuilderRun(db, "failed", `codex_cli project=${projectName}`, detail.slice(0, 2000));
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "failed",
      createdAt,
      currentTask: `Codex CLI improvement for ${projectName}`,
      taskId: queueTask.id,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
      designReview: rowString(project.localDesignReview) || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: rowString(project.localQaStatus) || null,
      qaChecklist: parseQaChecklist(project.localQaChecklist),
      files: changedFiles,
    };
  }

  await updateExecutionQueueTask(userId, queueTask.id, {
    status: "qa_pending",
    result: `Codex edited ${changedFiles.length} file(s). Running npm build and QA.`,
    log: `Codex completed. Changed files: ${changedFiles.join(", ") || "none"}.`,
  });
  await updateProjectBuildState(db, projectId, "qa_pending", `${log}\nCodex CLI: build validation started.\n`);

  const build = await runDetailed("npm", ["run", "build"], folder, { nodeEnv: "production", displayCommand: "npm run build" });
  log += `\n\nCodex build: ${build.ok ? "passed" : "failed"}\nCommand: ${build.command}\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}\n`;
  if (!build.ok) {
    const detail = `npm run build failed after Codex CLI.\n${build.output}`;
    await updateExecutionQueueTask(userId, queueTask.id, { status: "failed", error: detail, log: "Build failed after Codex CLI." });
    await updateProjectBuildState(db, projectId, "failed", log, detail);
    await logLocalBuilderRun(db, "failed", `codex_cli project=${projectName}`, detail.slice(0, 2000));
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "failed",
      createdAt,
      currentTask: `Codex CLI improvement for ${projectName}`,
      taskId: queueTask.id,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
      designReview: rowString(project.localDesignReview) || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: "qa_failed",
      qaChecklist: parseQaChecklist(project.localQaChecklist),
      files: changedFiles,
    };
  }

  await db.execute({
    sql: `UPDATE Project SET status = 'qa_pending', localQaStatus = 'qa_pending', localQaChecklist = NULL, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [`${log}\nQA: Codex build passed; checklist rerun started.\n`.slice(-12000), projectId],
  });

  const qaProject = await runLocalBuilderQa(userId, projectId);
  const passed = qaProject.qaStatus === "qa_passed";
  await updateExecutionQueueTask(userId, queueTask.id, {
    status: passed ? "qa_passed" : "failed",
    result: `Codex changed files: ${changedFiles.join(", ") || "none"}\nBuild: passed\nQA: ${qaProject.qaStatus}`,
    error: passed ? null : qaProject.buildError,
    log: `QA rerun finished with ${qaProject.qaStatus}.`,
  });
  await logLocalBuilderRun(
    db,
    passed ? "completed" : "failed",
    `codex_cli project=${projectName}`,
    `Changed files: ${changedFiles.join(", ") || "none"}\nBuild passed\nQA: ${qaProject.qaStatus}`
  );

  return {
    ...qaProject,
    currentTask: `Codex CLI improvement for ${projectName}`,
    taskId: queueTask.id,
    files: changedFiles,
  };
}

export async function rebuildLocalStarterApp(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const gate = canStartBuildWithFuguGate(project);
  if (!gate.allowed) throw new Error(gate.reason);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const taskId = crypto.randomUUID();
  let log = `${rowString(project.localBuildLog)}\nRebuild requested\n`.trim();

  try {
    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], folder, "production");
    log += `\n\nRebuild: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);
    log += "\nQA: rebuild passed; checklist pending.\n";
    await updateProjectBuildState(db, projectId, "qa_pending", log);
    await db.execute({
      sql: `UPDATE Project SET localQaStatus = 'qa_pending', localQaChecklist = NULL, updatedAt = datetime('now') WHERE id = ?`,
      args: [projectId],
    });
    await logLocalBuilderRun(db, "completed", `local_build_rebuild project=${projectName}`, `Build passed; QA pending: ${folder}`);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "qa_pending",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
      designReview: rowString(project.localDesignReview) || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: "qa_pending",
      qaChecklist: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await db.execute({
      sql: `UPDATE Project SET localQaStatus = 'qa_failed', updatedAt = datetime('now') WHERE id = ?`,
      args: [projectId],
    }).catch(() => undefined);
    await logLocalBuilderRun(db, "failed", `local_build_rebuild project=${projectName}`, detail);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Build Failed",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
      designReview: rowString(project.localDesignReview) || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: "qa_failed",
      qaChecklist: parseQaChecklist(project.localQaChecklist),
    };
  }
}

export async function openLocalProjectFolder(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  let log = `${rowString(project.localBuildLog)}\nOpen Folder: ${folder}`.trim();
  try {
    const child = spawn("code", [folder], { detached: true, shell: process.platform === "win32", stdio: "ignore" });
    child.unref();
    log += "\nVS Code open command sent.";
  } catch (error) {
    log += `\nVS Code open failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await updateProjectBuildState(db, projectId, rowString(project.status) || "Build Passed", log, null);
  await logLocalBuilderRun(db, "completed", `local_build_open_folder project=${projectName}`, folder);
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: rowString(project.status) || "Build Passed",
    createdAt,
    currentTask: `Open folder for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: rowString(project.localDesignReview) || null,
    polishReview: rowString(project.localPolishReview) || null,
    designScore: rowNumber(project.designScore),
    qaStatus: rowString(project.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project.localQaChecklist),
  };
}

export async function startLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const existing = devServers.get(projectId);
  if (existing && !existing.child.killed && await previewResponds(existing.url)) {
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Dev Server Running",
      createdAt,
      currentTask: `Preview ${projectName}`,
      taskId: crypto.randomUUID(),
      buildLog: rowString(project.localBuildLog),
      buildError: null,
      localDevUrl: existing.url,
      localDevPid: existing.pid,
      previewStatus: "online",
      researchBrief: rowString(project.localResearchBrief) || null,
      designReview: rowString(project.localDesignReview) || null,
      polishReview: rowString(project.localPolishReview) || null,
      designScore: rowNumber(project.designScore),
      qaStatus: rowString(project.localQaStatus) || null,
      qaChecklist: parseQaChecklist(project.localQaChecklist),
    };
  }

  const port = await nextAvailablePort(3000);
  const url = `http://localhost:${port}`;
  let output = `${rowString(project.localBuildLog)}\nStarting dev server at ${url}\n`.trim();
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: folder,
    shell: process.platform === "win32",
    env: childProcessEnv("development"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  devServers.set(projectId, { child, url, pid: child.pid ?? null });
  child.stdout?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.stderr?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.on("exit", () => {
    const current = devServers.get(projectId);
    if (current?.child === child) {
      devServers.delete(projectId);
      const staleLog = `${output}\nPreview process exited; preview marked stale.`.slice(-12000);
      void updateProjectDevState(db, projectId, "Preview Stale", url, null, staleLog).catch(() => undefined);
    }
  });

  try {
    await waitForPreview(url);
  } catch (error) {
    if (child.pid) await killProcessTree(child.pid).catch(() => undefined);
    devServers.delete(projectId);
    output = `${output}\n${error instanceof Error ? error.message : String(error)}`.slice(-12000);
    await updateProjectDevState(db, projectId, "Preview Stale", url, null, output);
    throw error;
  }
  await updateProjectDevState(db, projectId, "Dev Server Running", url, child.pid ?? null, output);
  await logLocalBuilderRun(db, "completed", `local_build_start_dev project=${projectName}`, `Dev Server Running: ${url}`);

  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Running",
    createdAt,
    currentTask: `Preview ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: output.slice(-12000),
    buildError: null,
    localDevUrl: url,
    localDevPid: child.pid ?? null,
    previewStatus: "online",
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: rowString(project.localDesignReview) || null,
    polishReview: rowString(project.localPolishReview) || null,
    designScore: rowNumber(project.designScore),
    qaStatus: rowString(project.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project.localQaChecklist),
  };
}

export async function stopLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const running = devServers.get(projectId);
  if (running?.pid) await killProcessTree(running.pid);
  else if (typeof project.localDevPid === "number") await killProcessTree(project.localDevPid);
  devServers.delete(projectId);
  const log = `${rowString(project.localBuildLog)}\nDev Server Stopped`.trim();
  await updateProjectDevState(db, projectId, "Dev Server Stopped", null, null, log);
  await logLocalBuilderRun(db, "completed", `local_build_stop_dev project=${projectName}`, "Dev Server Stopped");
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Stopped",
    createdAt,
    currentTask: `Stop preview for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
    previewStatus: "offline",
    researchBrief: rowString(project.localResearchBrief) || null,
    designReview: rowString(project.localDesignReview) || null,
    polishReview: rowString(project.localPolishReview) || null,
    designScore: rowNumber(project.designScore),
    qaStatus: rowString(project.localQaStatus) || null,
    qaChecklist: parseQaChecklist(project.localQaChecklist),
  };
}

export async function runBrowserQaForProject(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  let url = rowString(project.localDevUrl);
  if (!url || !(await previewResponds(url))) {
    const preview = await startLocalDevServer(userId, projectId);
    url = preview.localDevUrl ?? "";
  }
  if (!url) throw new Error("Browser QA requires a running local preview.");

  const browserQa = await runBrowserQa(url);
  const latest = await findLocalBuildProject(db, userId, projectId);
  const existingChecklist = parseQaChecklist(latest.localQaChecklist) ?? [];
  const browserKeys = new Set(browserQa.checks.map((check) => check.key));
  const checklist = [...existingChecklist.filter((item) => !browserKeys.has(item.key)), ...browserQa.checks];
  const staticFailed = existingChecklist.some((item) => item.status === "failed" && ["homepage_loads", "primary_buttons_clickable"].includes(item.key));
  const qaStatus = browserQa.passed && !staticFailed ? "qa_passed" : "qa_pending";
  const summary = browserQa.passed
    ? `Browser QA passed at ${url}.`
    : `Browser QA needs review at ${url}: ${browserQa.checks.filter((item) => item.status === "failed").map((item) => item.label).join(", ")}.`;
  await db.execute({
    sql: `UPDATE Project SET localQaStatus = ?, localQaChecklist = ?, localPreviewStatus = 'online', localPreviewCheckedAt = datetime('now'), localBuildLog = substr(coalesce(localBuildLog, '') || char(10) || ?, -12000), updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
    args: [qaStatus, JSON.stringify(checklist), summary, projectId, userId],
  });
  await logLocalBuilderRun(db, browserQa.passed ? "completed" : "failed", `browser_qa project=${rowString(project.projectName)}`, summary);
  const updated = await findLocalBuildProject(db, userId, projectId);
  return {
    id: projectId,
    projectName: rowString(updated.projectName),
    localFolderPath: rowString(updated.localFolderPath),
    status: qaStatus,
    createdAt: rowString(updated.createdAt) || new Date().toISOString(),
    currentTask: `Browser QA for ${rowString(updated.projectName)}`,
    taskId: crypto.randomUUID(),
    buildLog: rowString(updated.localBuildLog),
    buildError: null,
    localDevUrl: url,
    localDevPid: typeof updated.localDevPid === "number" ? updated.localDevPid : null,
    previewStatus: "online",
    researchBrief: rowString(updated.localResearchBrief) || null,
    designReview: rowString(updated.localDesignReview) || null,
    polishReview: rowString(updated.localPolishReview) || null,
    designScore: rowNumber(updated.designScore),
    qaStatus,
    qaChecklist: checklist,
  };
}

export async function startPreviewAndRunBrowserQa(userId: string, projectId: string): Promise<LocalBuildProject> {
  await startLocalDevServer(userId, projectId);
  return runBrowserQaForProject(userId, projectId);
}

export async function markDeadPreviewsStale(): Promise<number> {
  const db = getDb();
  await ensureLocalBuilderColumns(db);
  const rows = await db.execute(`SELECT id, localDevUrl, localBuildLog FROM Project WHERE localDevUrl IS NOT NULL AND localPreviewStatus = 'online'`);
  let stale = 0;
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const url = rowString(row.localDevUrl);
    if (!url || await previewResponds(url)) continue;
    const log = `${rowString(row.localBuildLog)}\nPreview health check failed; preview marked stale.`.slice(-12000);
    await updateProjectDevState(db, rowString(row.id), "Preview Stale", url, null, log);
    stale++;
  }
  return stale;
}
