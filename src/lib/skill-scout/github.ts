import { prisma } from "@/lib/db";
import { createApproval } from "@/lib/approvals";
import { sanitizeGitHubHeaderValue, sanitizeGitHubRepoInput } from "@/lib/hermes-execution/tools/internal-tools";

export type SkillScoutAction =
  | "convert_to_knowledge_card"
  | "add_builder_skill"
  | "add_fugu_review_rule"
  | "add_qa_check"
  | "add_tool_registry_entry"
  | "ignore"
  | "later";

export type SkillScoutPriority = "high" | "medium" | "low";

export type SkillScoutCandidate = {
  name: string;
  sourceRepo: string;
  sourcePath: string;
  sourceUrl: string;
  category: string;
  summary: string;
  whyItHelpsParawi: string;
  overlapWithExistingSystem: string;
  implementationDifficulty: string;
  riskLevel: "low" | "medium" | "high";
  recommendedAction: SkillScoutAction;
  scores: {
    benefit: number;
    risk: number;
    effort: number;
    priority: SkillScoutPriority;
  };
  expectedFilesChanged: string[];
  rollbackPlan: string;
};

export type SkillScoutResult = {
  repoUrl: string;
  repo: {
    fullName: string;
    description: string | null;
    defaultBranch: string;
    stars: number;
    language: string | null;
    topics: string[];
  };
  inspected: {
    treeItems: number;
    candidateFiles: number;
    scriptsRun: false;
    filesImported: false;
  };
  candidates: SkillScoutCandidate[];
  approvals: Array<{ id: string; candidateName: string; actionType: string; status: string }>;
  safetyNotes: string[];
};

type GitHubTreeItem = {
  path: string;
  type: "blob" | "tree";
  size?: number;
  url?: string;
};

type GitHubTreeResponse = {
  tree?: GitHubTreeItem[];
  truncated?: boolean;
};

type GitHubRepoResponse = {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
  html_url: string;
};

const GITHUB_PREFIX = "https://github.com/";
const MAX_TREE_ITEMS = 5000;
const MAX_APPROVALS = 5;

const BLOCKED_PATH_RE = /(^|\/)(node_modules|dist|build|coverage|\.next|\.git|vendor)(\/|$)|(^|\/)\.env($|[./])|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.min\.js$|\.wasm$|\.exe$|\.dll$|\.zip$|\.tar$|\.gz$|\.png$|\.jpg$|\.jpeg$|\.gif$|\.pdf$/i;

const CATEGORY_RULES: Array<{
  category: string;
  action: SkillScoutAction;
  terms: string[];
  benefit: number;
  effort: number;
  risk: number;
  target: string[];
  why: string;
}> = [
  {
    category: "Design Systems",
    action: "convert_to_knowledge_card",
    terms: ["design-system", "design_system", "tokens", "tailwind", "component-library"],
    benefit: 9,
    effort: 4,
    risk: 3,
    target: ["catalog/design/", "catalog/skills/"],
    why: "Improves Builder consistency, token discipline, component APIs, and generated UI polish.",
  },
  {
    category: "Accessibility",
    action: "add_qa_check",
    terms: ["accessibility", "a11y", "wcag", "aria", "screen-reader"],
    benefit: 9,
    effort: 3,
    risk: 2,
    target: ["catalog/design/accessibility.md", "catalog/skills/frontend-qa.md"],
    why: "Catches keyboard, focus, contrast, label, and semantic regressions before generated apps ship.",
  },
  {
    category: "Next.js / React Quality",
    action: "add_builder_skill",
    terms: ["nextjs", "next-js", "react", "app-router", "server-components", "frontend"],
    benefit: 8,
    effort: 5,
    risk: 4,
    target: ["catalog/skills/", "agents/builder/context.yaml"],
    why: "Gives Parawi stronger defaults for App Router structure, client/server boundaries, loading states, and React quality.",
  },
  {
    category: "Frontend QA",
    action: "add_qa_check",
    terms: ["e2e", "playwright", "cypress", "testing", "qa", "browser-test"],
    benefit: 8,
    effort: 5,
    risk: 3,
    target: ["catalog/skills/frontend-qa.md", "src/lib/skill-scout/"],
    why: "Adds concrete checks for critical generated-app flows, responsive behavior, and browser-visible regressions.",
  },
  {
    category: "Browser Automation",
    action: "add_tool_registry_entry",
    terms: ["browser", "automation", "puppeteer", "playwright", "selenium"],
    benefit: 7,
    effort: 6,
    risk: 5,
    target: ["src/lib/hermes-execution/tools/", "catalog/skills/"],
    why: "Can help verify live generated pages, but needs a tight sandbox and explicit approval before becoming a tool.",
  },
  {
    category: "E-commerce Apps",
    action: "convert_to_knowledge_card",
    terms: ["ecommerce", "commerce", "stripe", "checkout", "shopify", "cart", "payments"],
    benefit: 7,
    effort: 5,
    risk: 6,
    target: ["catalog/skills/", "catalog/policies/"],
    why: "Improves checkout, cart, product page, and payment-aware app generation while keeping payment code gated.",
  },
  {
    category: "Research Workflows",
    action: "convert_to_knowledge_card",
    terms: ["research", "web-research", "citation", "scrape", "browser-research"],
    benefit: 6,
    effort: 4,
    risk: 4,
    target: ["catalog/skills/", "docs/"],
    why: "Helps Parawi collect and summarize external product or market context before building.",
  },
  {
    category: "Job Automation",
    action: "later",
    terms: ["job", "resume", "ats", "linkedin", "application"],
    benefit: 5,
    effort: 5,
    risk: 5,
    target: ["catalog/skills/", "agents/athena/"],
    why: "Potentially useful for Athena workflows, but less central to Builder output quality.",
  },
  {
    category: "Memory / Knowledge Cards",
    action: "convert_to_knowledge_card",
    terms: ["knowledge-card", "memory", "notes", "rag", "context"],
    benefit: 6,
    effort: 4,
    risk: 4,
    target: ["catalog/skills/", "catalog/policies/"],
    why: "May improve reusable Builder context, but should avoid duplicating Hermes memory systems.",
  },
];

function parseGitHubRepoUrl(input: string): { repoUrl?: string; owner?: string; repo?: string; error?: string } {
  const sanitized = sanitizeGitHubRepoInput(input);
  const candidate = sanitized.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, "");
  if (!candidate) return { error: "No GitHub URL found. Skill Scout v1 supports URLs like https://github.com/owner/repo." };
  if (!candidate.startsWith(GITHUB_PREFIX)) return { error: "Skill Scout v1 only supports URLs that start with https://github.com/." };

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: "Invalid GitHub URL. Use https://github.com/owner/repo." };
  }
  if (url.origin !== "https://github.com") return { error: "Skill Scout v1 only supports github.com URLs over HTTPS." };

  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
    return { error: "Invalid GitHub repo URL. Use https://github.com/owner/repo." };
  }
  return { repoUrl: `https://github.com/${owner}/${repo}`, owner, repo };
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ? sanitizeGitHubHeaderValue(process.env.GITHUB_TOKEN) : "";
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "parawi-skill-scout",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Repository was not found on GitHub.");
    if (res.status === 403) throw new Error("GitHub rate-limited this request. Set a clean GITHUB_TOKEN to increase limits.");
    throw new Error(`GitHub API returned ${res.status}.`);
  }
  return res.json() as Promise<T>;
}

function isSafePath(path: string): boolean {
  return !BLOCKED_PATH_RE.test(path);
}

function readableName(path: string): string {
  return path
    .split("/")
    .filter((part) => !["skills", "plugins", "src", "lib"].includes(part.toLowerCase()))
    .pop()
    ?.replace(/\.md$/i, "")
    .replace(/^skill$/i, path.split("/").slice(-2, -1)[0] ?? "skill")
    ?? path;
}

function classify(path: string): typeof CATEGORY_RULES[number] | null {
  const normalized = path.toLowerCase();
  const matches = CATEGORY_RULES
    .map((rule) => ({ rule, hits: rule.terms.filter((term) => normalized.includes(term)).length }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.rule.benefit - a.rule.benefit);
  return matches[0]?.rule ?? null;
}

function summarizePath(path: string, category: string): string {
  if (/skill\.md$/i.test(path)) return `Skill instructions for ${readableName(path)} in the ${category.toLowerCase()} category.`;
  if (/readme|docs/i.test(path)) return `Documentation pattern related to ${category.toLowerCase()}.`;
  return `Repository file related to ${category.toLowerCase()}.`;
}

function difficulty(effort: number): string {
  if (effort <= 3) return "low";
  if (effort <= 6) return "medium";
  return "high";
}

function riskLabel(risk: number): "low" | "medium" | "high" {
  if (risk <= 3) return "low";
  if (risk <= 6) return "medium";
  return "high";
}

function priority(benefit: number, risk: number, effort: number): SkillScoutPriority {
  const value = benefit * 1.5 - risk - effort * 0.4;
  if (value >= 7) return "high";
  if (value >= 4) return "medium";
  return "low";
}

function buildCandidates(repoFullName: string, repoUrl: string, tree: GitHubTreeItem[]): SkillScoutCandidate[] {
  const byName = new Map<string, SkillScoutCandidate>();
  const safeBlobs = tree
    .filter((item) => item.type === "blob")
    .filter((item) => isSafePath(item.path))
    .filter((item) => /(^|\/)(skill\.md|readme\.md)$|\.md$/i.test(item.path))
    .slice(0, MAX_TREE_ITEMS);

  for (const item of safeBlobs) {
    const rule = classify(item.path);
    if (!rule) continue;

    const name = readableName(item.path);
    const risk = rule.risk + (/stripe|payment|browser|automation/i.test(item.path) ? 1 : 0);
    const candidate: SkillScoutCandidate = {
      name,
      sourceRepo: repoFullName,
      sourcePath: item.path,
      sourceUrl: `${repoUrl}/blob/HEAD/${item.path}`,
      category: rule.category,
      summary: summarizePath(item.path, rule.category),
      whyItHelpsParawi: rule.why,
      overlapWithExistingSystem: overlapFor(rule.category),
      implementationDifficulty: difficulty(rule.effort),
      riskLevel: riskLabel(risk),
      recommendedAction: rule.action,
      scores: {
        benefit: rule.benefit,
        risk,
        effort: rule.effort,
        priority: priority(rule.benefit, risk, rule.effort),
      },
      expectedFilesChanged: rule.target,
      rollbackPlan: "Revert the approved catalog/agent/src changes from the importing commit; no external repo files are executed during scouting.",
    };

    const key = `${candidate.category}:${candidate.name}`.toLowerCase();
    const existing = byName.get(key);
    if (!existing || scoreValue(candidate) > scoreValue(existing)) byName.set(key, candidate);
  }

  return Array.from(byName.values())
    .filter((candidate) => !/orchestrator|agent-pack|multi-agent|memory-system/i.test(`${candidate.name} ${candidate.sourcePath}`))
    .sort((a, b) => scoreValue(b) - scoreValue(a))
    .slice(0, MAX_APPROVALS);
}

function overlapFor(category: string): string {
  if (category === "Memory / Knowledge Cards") return "Potential overlap with Iris and catalog knowledge cards; adapt only reusable card guidance.";
  if (category === "Browser Automation") return "Overlaps with existing QA/build verification; add only guarded checks.";
  if (category === "Accessibility") return "Complements existing design accessibility cards and frontend QA.";
  if (category === "Design Systems") return "Complements catalog/design and Builder standards.";
  return "Partial overlap with Builder/Fugu guidance; adapt as a narrow rule or card.";
}

function scoreValue(candidate: SkillScoutCandidate): number {
  return candidate.scores.benefit * 10 - candidate.scores.risk * 4 - candidate.scores.effort * 2;
}

function approvalPayload(candidate: SkillScoutCandidate) {
  return {
    scoutVersion: "v1",
    candidateName: candidate.name,
    sourceRepo: candidate.sourceRepo,
    sourcePath: candidate.sourcePath,
    sourceUrl: candidate.sourceUrl,
    recommendedAction: candidate.recommendedAction,
    destination: candidate.expectedFilesChanged,
    whyItHelps: candidate.whyItHelpsParawi,
    riskLevel: candidate.riskLevel,
    filesExpectedToChange: candidate.expectedFilesChanged,
    rollbackPlan: candidate.rollbackPlan,
    safety: [
      "Approval is for a later import/adaptation step.",
      "Do not run external repo scripts.",
      "Do not copy .env, secrets, binaries, node_modules, build artifacts, or lockfiles.",
      "Keep writes inside approved Parawi locations only.",
    ],
  };
}

async function logScout(userId: string, result: SkillScoutResult): Promise<void> {
  const top = result.candidates.slice(0, 5).map((c) => `${c.name} (${c.category}, ${c.scores.priority})`).join(", ");
  await prisma.agentRun.create({
    data: {
      agentName: "skill-scout",
      inputSummary: `repo=${result.repo.fullName}`,
      outputSummary: `Found ${result.candidates.length} candidate(s). Top: ${top || "none"}. Approvals queued: ${result.approvals.length}.`,
      modelProvider: "github-api",
      status: "completed",
    },
  }).catch(() => undefined);

  await prisma.memory.create({
    data: {
      userId,
      fact: `Skill Scout inspected ${result.repo.fullName}. Recommended ${result.candidates.length} candidate(s), queued ${result.approvals.length} approval request(s), and imported no files. Top: ${top || "none"}.`,
      source: "skill-scout",
      approvedAt: new Date(),
    },
  }).catch(() => undefined);
}

export async function runSkillScout(userId: string, inputUrl: string): Promise<SkillScoutResult> {
  const parsed = parseGitHubRepoUrl(inputUrl);
  if (!parsed.owner || !parsed.repo || !parsed.repoUrl) throw new Error(parsed.error ?? "Invalid GitHub URL.");

  const repoApi = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const repo = await githubJson<GitHubRepoResponse>(repoApi);
  const tree = await githubJson<GitHubTreeResponse>(
    `${repoApi}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
  );
  const treeItems = (tree.tree ?? []).slice(0, MAX_TREE_ITEMS);
  const candidates = buildCandidates(repo.full_name, parsed.repoUrl, treeItems);
  const highValue = candidates.filter((candidate) => candidate.scores.priority === "high");

  const approvals = [];
  for (const candidate of highValue) {
    const approval = await createApproval(userId, "skill_scout_import", approvalPayload(candidate));
    approvals.push({
      id: approval.id,
      candidateName: candidate.name,
      actionType: approval.actionType,
      status: approval.status,
    });
  }

  const result: SkillScoutResult = {
    repoUrl: parsed.repoUrl,
    repo: {
      fullName: repo.full_name,
      description: repo.description,
      defaultBranch: repo.default_branch,
      stars: repo.stargazers_count,
      language: repo.language,
      topics: repo.topics ?? [],
    },
    inspected: {
      treeItems: treeItems.length,
      candidateFiles: treeItems.filter((item) => item.type === "blob" && isSafePath(item.path)).length,
      scriptsRun: false,
      filesImported: false,
    },
    candidates,
    approvals,
    safetyNotes: [
      "Used GitHub metadata and git tree APIs only.",
      "No repository scripts were run.",
      "No files were copied or imported.",
      "Approval is required before any adaptation or import.",
      tree.truncated ? "GitHub returned a truncated tree; recommendations may be incomplete." : "GitHub returned the full available tree.",
    ],
  };

  await logScout(userId, result);
  return result;
}
