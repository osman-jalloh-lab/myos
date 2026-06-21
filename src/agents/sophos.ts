// Sophos — skills & capability scout (added 2026-06-07, Phase 8)
// Owns ONLY these tools (this is what enforces no-overlap): "release-watch","repo-scout","video-digest","skill-brief"
// CAN: watch Claude/Anthropic release notes, scout GitHub for capability/tooling
//      repos, surface relevant YouTube videos, and synthesize it all into a digest
// CANNOT: install, configure, apply, or propose any write — pure L0 read-only
//      watcher (the same autonomy tier as Argus). A digest is the entire output.

import { prisma } from "@/lib/db";
import { callModel } from "@/lib/modelRouter";
import { fetchReleaseNotes, repoScout, videoDigest, checkNewSkills, type ScoutedRepo, type ScoutedVideo, type NewSkillsResult } from "@/lib/sophos";

export const sophos = {
  name: "Sophos",
  domain: "skills & capability scouting",
  tools: ["release-watch", "repo-scout", "video-digest", "skill-brief"] as const,
};

// Topics Sophos scouts for — targeted at Claude Code skills, MCP servers,
// and GRC/AI tooling that could be added to Hermes OS or Osman's workflow.
export const SCOUT_TOPICS = [
  "claude-code MCP server tool",
  "AI agent workflow automation tool",
  "GRC compliance automation AI",
];

// ── release-watch ─────────────────────────────────────────────────────────────

export async function releaseWatch(): Promise<string | null> {
  return fetchReleaseNotes();
}

// ── repo-scout ────────────────────────────────────────────────────────────────

export async function repoScoutTool(query: string): Promise<ScoutedRepo[]> {
  return repoScout(query);
}

// ── video-digest ──────────────────────────────────────────────────────────────

export async function videoDigestTool(query: string): Promise<ScoutedVideo[]> {
  return videoDigest(query);
}

// ── new-skills check ─────────────────────────────────────────────────────────

export async function checkSkillsRepo(userId: string): Promise<NewSkillsResult> {
  return checkNewSkills(userId);
}

// ── skill-brief ───────────────────────────────────────────────────────────────
// Synthesizes whatever release-watch/repo-scout/video-digest turned up into a
// short "here's what's new and might help you" digest via Groq (PUBLIC data —
// none of this touches Osman's personal accounts). Logged to model_usage like
// every other model call, and to AgentRun so it shows up on the dashboard.

export interface SkillBriefInput {
  releaseNotes: string | null;
  repos: ScoutedRepo[];
  videos: ScoutedVideo[];
  newSkills?: NewSkillsResult;
}

export interface SkillBriefResult {
  text: string;
  hasFindings: boolean;
}

const SKILL_BRIEF_SYSTEM_PROMPT = `You are Sophos, Hermes OS's skills-and-capability scout.
Osman is heading toward a GRC (governance, risk, compliance) consulting career —
he holds Security+ and CySA+, works in HR compliance and IT, and is building an AI
agent system (Hermes OS) himself. Your job is to look at what's new in the AI/agent
and security-tooling space and tell him plainly which of it might actually help him —
not a press-release summary, a "here's what I'd look at first and why" from someone
who knows his direction. Be brief, concrete, and skip anything irrelevant to him.
No em dashes.`;

function buildBriefPrompt(input: SkillBriefInput): string {
  const sections: string[] = [];

  // New Claude Code skills — always leads if present
  if (input.newSkills && input.newSkills.newSkills.length > 0) {
    sections.push(
      `NEW Claude Code skills available in affaan-m/everything-claude-code (${input.newSkills.totalInRepo} total, ${input.newSkills.newSkills.length} new since last check):\n` +
      input.newSkills.newSkills.map((s) => `- ${s}`).join("\n") +
      `\n\nThese can be installed with: npx skills add affaan-m/everything-claude-code/<skill-name>`
    );
  } else if (input.newSkills) {
    sections.push(
      `Claude Code skills (affaan-m/everything-claude-code): ${input.newSkills.totalInRepo} total — no new ones since last check.`
    );
  }

  sections.push(
    input.releaseNotes
      ? `Claude/Anthropic release notes (recent excerpt):\n${input.releaseNotes.slice(0, 2500)}`
      : "Release notes: unavailable this run (FIRECRAWL_API_KEY not set — fell back to raw page fetch)."
  );

  sections.push(
    input.repos.length
      ? `GitHub repos found in capability/tooling search:\n${input.repos
          .map((r) => `- ${r.fullName} (${r.stars}★) — ${r.description ?? "no description"} — ${r.url}`)
          .join("\n")}`
      : "GitHub repo search: nothing found this run."
  );

  if (input.videos.length) {
    sections.push(
      `Recent relevant videos:\n${input.videos.map((v) => `- "${v.title}" — ${v.channel} (${v.url})`).join("\n")}`
    );
  }

  return (
    sections.join("\n\n") +
    "\n\nWrite a concise digest (4-8 sentences). Lead with any new Claude Code skills — name them specifically and say whether they're worth installing. Then cover anything else worth Osman's attention. Be direct. Skip anything clearly irrelevant."
  );
}

export async function skillBrief(userId: string, input: SkillBriefInput): Promise<SkillBriefResult> {
  const hasNewSkills = (input.newSkills?.newSkills.length ?? 0) > 0;
  const hasFindings = hasNewSkills || Boolean(input.releaseNotes) || input.repos.length > 0 || input.videos.length > 0;

  if (!hasFindings) {
    return {
      text: "No fresh signal this run — release notes fetch, GitHub search, and skills check all came back empty.",
      hasFindings: false,
    };
  }

  const result = await callModel({
    userId,
    taskType: "sophos-skill-brief",
    dataClass: "PUBLIC",
    systemPrompt: SKILL_BRIEF_SYSTEM_PROMPT,
    userPrompt: buildBriefPrompt(input),
  });

  await prisma.agentRun.create({
    data: {
      agentName: "sophos",
      inputSummary: `skill-brief: ${input.repos.length} repos, ${input.videos.length} videos, release notes ${input.releaseNotes ? "fetched" : "unavailable"}`,
      outputSummary: result.text.slice(0, 2000),
      modelProvider: result.provider,
      status: "completed",
    },
  });

  return { text: result.text, hasFindings: true };
}
