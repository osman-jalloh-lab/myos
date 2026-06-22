// Capability-scouting data layer for Sophos. Every connector here is read-only
// signal — Sophos never installs, configures, or applies anything; it only
// produces digests for Osman to act on himself (see skill-brief in @/agents/sophos).

import { prisma } from "@/lib/db";

const RELEASE_NOTES_URL = "https://docs.anthropic.com/en/release-notes/overview";

// The primary skills repo Sophos tracks for new installable Claude Code skills.
const SKILLS_REPO_OWNER = "affaan-m";
const SKILLS_REPO_NAME = "everything-claude-code";
const SKILLS_MEMORY_KEY = "sophos:known_skills";

/**
 * release-watch — scrapes Anthropic/Claude release notes via Firecrawl.
 * Falls back to a direct fetch if Firecrawl key is absent — still gets the
 * page, just without markdown conversion.
 */
export async function fetchReleaseNotes(): Promise<string | null> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;

  if (firecrawlKey) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: RELEASE_NOTES_URL, formats: ["markdown"], onlyMainContent: true }),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { markdown?: string } };
        const md = data.data?.markdown;
        if (md) return md.slice(0, 6000);
      }
    } catch { /* fall through to direct fetch */ }
  }

  // No Firecrawl key — hit the page directly and pull the raw text.
  try {
    const res = await fetch(RELEASE_NOTES_URL, {
      headers: { "User-Agent": "hermes-os-sophos/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip HTML tags and collapse whitespace for a rough plain-text excerpt.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 4000) || null;
  } catch {
    return null;
  }
}

// ── New skills tracker ────────────────────────────────────────────────────────

export interface NewSkillsResult {
  newSkills: string[];
  totalInRepo: number;
  lastChecked: string | null;
}

interface GithubTreeItem {
  path: string;
  type: string;
}

/**
 * checkNewSkills — compares the current skill list in affaan-m/everything-claude-code
 * against the last-known list stored in the Memory table. Returns any skills
 * that have appeared since the last run. Uses public GitHub API — no token needed.
 */
export async function checkNewSkills(userId: string): Promise<NewSkillsResult> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "hermes-os-sophos",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Fetch repo tree (top-level only — each skill is a top-level directory)
  const res = await fetch(
    `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/git/trees/main?recursive=0`,
    { headers, signal: AbortSignal.timeout(15_000) }
  );

  if (!res.ok) {
    const alt = await fetch(
      `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/contents/`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );
    if (!alt.ok) return { newSkills: [], totalInRepo: 0, lastChecked: null };

    const items = (await alt.json()) as Array<{ name: string; type: string }>;
    const skills = items
      .filter((i) => i.type === "dir" && !i.name.startsWith(".") && i.name !== "node_modules")
      .map((i) => i.name)
      .sort();

    return await diffSkills(userId, skills);
  }

  const tree = (await res.json()) as { tree?: GithubTreeItem[] };
  const skills = (tree.tree ?? [])
    .filter((i) => i.type === "tree" && !i.path.includes("/") && !i.path.startsWith("."))
    .map((i) => i.path)
    .sort();

  return await diffSkills(userId, skills);
}

async function diffSkills(userId: string, currentSkills: string[]): Promise<NewSkillsResult> {
  // Load the last-known skill list from Memory table
  const stored = await prisma.memory.findFirst({
    where: { userId, fact: { startsWith: SKILLS_MEMORY_KEY } },
    orderBy: { createdAt: "desc" },
  });

  let knownSkills: string[] = [];
  let lastChecked: string | null = null;

  if (stored) {
    lastChecked = stored.createdAt.toISOString();
    try {
      // Format stored: "sophos:known_skills::[\"skill1\",\"skill2\",...]"
      const jsonPart = stored.fact.slice(SKILLS_MEMORY_KEY.length + 2);
      knownSkills = JSON.parse(jsonPart) as string[];
    } catch { /* first run or corrupt — treat all as new */ }
  }

  const knownSet = new Set(knownSkills);
  const newSkills = currentSkills.filter((s) => !knownSet.has(s));

  // Persist the updated skill list so next run only reports genuinely new ones
  if (currentSkills.length > 0) {
    const fact = `${SKILLS_MEMORY_KEY}::${JSON.stringify(currentSkills)}`;
    await prisma.memory.create({
      data: { userId, fact: fact.slice(0, 2000), source: "sophos" },
    });
    // Clean up stale entries (keep only the latest)
    if (stored) {
      await prisma.memory.deleteMany({
        where: {
          userId,
          fact: { startsWith: SKILLS_MEMORY_KEY },
          id: { not: stored.id },
          createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
    }
  }

  return { newSkills, totalInRepo: currentSkills.length, lastChecked };
}

// ── Skill relevance scorer ────────────────────────────────────────────────────

export interface ScoredSkill {
  name: string;
  score: number;
  reasons: string[];
}

// Keywords that indicate a skill is directly useful to Hermes OS or Osman's workflow.
// Grouped by domain — any match adds to the relevance score.
const RELEVANCE_GROUPS: Array<{ label: string; keywords: string[]; points: number }> = [
  {
    label: "Hermes OS stack",
    keywords: ["nextjs", "next", "prisma", "turso", "libsql", "vercel", "typescript", "react", "tailwind"],
    points: 8,
  },
  {
    label: "Claude/MCP integration",
    keywords: ["claude", "mcp", "anthropic", "model-context", "llm", "agent", "tool-use"],
    points: 10,
  },
  {
    label: "Agent orchestration",
    keywords: ["hermes", "orchestrat", "multi-agent", "agentic", "workflow", "pipeline", "autonomous"],
    points: 9,
  },
  {
    label: "Telegram/communication",
    keywords: ["telegram", "webhook", "bot", "notification", "alert", "message"],
    points: 7,
  },
  {
    label: "Memory/context",
    keywords: ["memory", "context", "session", "persistent", "recall", "knowledge"],
    points: 8,
  },
  {
    label: "Email/calendar",
    keywords: ["email", "gmail", "calendar", "google", "oauth", "inbox"],
    points: 6,
  },
  {
    label: "Engineering executor",
    keywords: ["github", "deploy", "branch", "pr", "pull-request", "executor", "engineering"],
    points: 6,
  },
  {
    label: "Security/GRC",
    keywords: ["security", "grc", "compliance", "audit", "csrf", "auth", "vulnerability", "nist", "soc"],
    points: 7,
  },
  {
    label: "Finance/budget",
    keywords: ["finance", "budget", "expense", "income", "payment", "billing"],
    points: 5,
  },
  {
    label: "Job/career tools",
    keywords: ["resume", "ats", "job", "career", "cover", "linkedin", "application"],
    points: 5,
  },
  {
    label: "Database/backend",
    keywords: ["database", "sql", "postgres", "api", "backend", "server", "cron"],
    points: 5,
  },
  {
    label: "Evaluation/testing",
    keywords: ["eval", "test", "benchmark", "quality", "review", "verify", "regression"],
    points: 6,
  },
];

export function scoreSkill(name: string, description = ""): ScoredSkill {
  const text = `${name} ${description}`.toLowerCase().replace(/[-_]/g, " ");
  let score = 0;
  const reasons: string[] = [];

  for (const group of RELEVANCE_GROUPS) {
    for (const kw of group.keywords) {
      if (text.includes(kw)) {
        score += group.points;
        reasons.push(group.label);
        break; // only count each group once per skill
      }
    }
  }

  return { name, score, reasons: [...new Set(reasons)] };
}

export async function scoreNewSkills(newSkills: string[]): Promise<ScoredSkill[]> {
  return newSkills
    .map((s) => scoreSkill(s))
    .filter((s) => s.score >= 6)
    .sort((a, b) => b.score - a.score);
}

// ── GitHub repo search ────────────────────────────────────────────────────────

export interface ScoutedRepo {
  name: string;
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  language: string | null;
  updatedAt: string;
}

interface GithubSearchItem {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  updated_at: string;
}

/**
 * repo-scout — searches public GitHub repos for capability/tooling keywords.
 * Capability-oriented queries (different from Athena's job-oriented queries).
 */
export async function repoScout(query: string, max = 5): Promise<ScoutedRepo[]> {
  const params = new URLSearchParams({ q: query, sort: "updated", order: "desc", per_page: String(max) });
  const res = await fetch(`https://api.github.com/search/repositories?${params}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "hermes-os-sophos" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`GitHub search ${res.status}`);
  const data = (await res.json()) as { items?: GithubSearchItem[] };
  return (data.items ?? []).map((item) => ({
    name: item.name,
    fullName: item.full_name,
    url: item.html_url,
    description: item.description,
    stars: item.stargazers_count,
    language: item.language,
    updatedAt: item.updated_at,
  }));
}

// ── YouTube digest ────────────────────────────────────────────────────────────

export interface ScoutedVideo {
  title: string;
  channel: string;
  url: string;
  publishedAt: string;
  description: string;
}

interface YoutubeSearchItem {
  id: { videoId?: string };
  snippet: {
    title: string;
    channelTitle: string;
    publishedAt: string;
    description: string;
  };
}

export async function videoDigest(query: string, max = 5): Promise<ScoutedVideo[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    order: "date",
    maxResults: String(max),
    key,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];

  const data = (await res.json()) as { items?: YoutubeSearchItem[] };
  return (data.items ?? [])
    .filter((item) => item.id.videoId)
    .map((item) => ({
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      publishedAt: item.snippet.publishedAt,
      description: item.snippet.description,
    }));
}
