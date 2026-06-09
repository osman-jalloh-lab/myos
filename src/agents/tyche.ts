// Tyche — income opportunity scout (added 2026-06-09)
// Owns ONLY these tools: "gig-scout","passive-income-scan","campus-job-scan","lavaall-leads"
// CAN: search freelance platforms, scan on-campus/CPT job boards, surface passive
//      income plays, identify LAVAALL client leads — all legal for F-1 status.
// CANNOT: apply, send, or write anything (Athena/Iris do that). Read-only scout.
// All results filtered through F-1/CPT authorization before surfacing.

import { prisma } from "@/lib/db";
import { callModel } from "@/lib/modelRouter";
import { discoverJobs } from "@/agents/athena";

export const tyche = {
  name: "Tyche",
  domain: "income opportunity scouting",
  tools: ["gig-scout", "passive-income-scan", "campus-job-scan", "lavaall-leads"] as const,
};

// Gig queries Tyche runs weekly against the job boards.
// Separated from Athena's SCOUT_QUERIES which target full career-track roles.
const GIG_QUERIES = [
  "cybersecurity freelance remote contract",
  "IT support part time Austin student",
  "web developer contract remote entry level",
  "HR compliance remote contract",
  "bug bounty cybersecurity",
  "on campus IT Austin Community College",
  "on campus IT UT Austin student worker",
];

// Passive income opportunities relevant to his skill profile.
// These are surfaced as curated suggestions, not scraped live.
const PASSIVE_PLAYS: { title: string; description: string; effort: string; earning: string; authorization: string }[] = [
  {
    title: "Sell CompTIA study guides on Gumroad",
    description: "Security+ and CySA+ notes/cheat sheets as PDF. One-time build, recurring sales.",
    effort: "3-5 hrs to build",
    earning: "$5-15/sale, low volume but zero ongoing work",
    authorization: "F-1 OK — passive income from digital products is not employment",
  },
  {
    title: "HackerOne bug bounty programs",
    description: "Open programs accepting student hunters. Focus on web application scopes matching his web dev skills.",
    effort: "Variable — evenings/weekends",
    earning: "$200-2,000 per valid finding (program-dependent)",
    authorization: "F-1 OK — bounty payments are prizes, not wages",
  },
  {
    title: "Fiverr: I-9/E-Verify compliance consulting",
    description: "Small businesses pay $50-150 for I-9 audit help. Osman does this daily at ACC HR.",
    effort: "1-2 hrs per gig",
    earning: "$50-150/gig",
    authorization: "Verify with DSO — off-campus freelance may require CPT authorization",
  },
  {
    title: "GitHub Sponsors on Hermes OS",
    description: "Once Hermes OS is public, enable GitHub Sponsors. Developer tools get traction.",
    effort: "Make repo public + write a good README",
    earning: "$0-500/month depending on traction",
    authorization: "F-1 OK — passive income from open source sponsorship",
  },
  {
    title: "UT Austin paid research studies",
    description: "UT regularly posts paid studies paying $10-100 for 1-2 hrs. Check utexas.edu/research/participate.",
    effort: "1-2 hrs per study",
    earning: "$10-100/study",
    authorization: "F-1 OK — research participation payments are not employment income",
  },
  {
    title: "Upwork: Next.js/React contract projects",
    description: "Entry-level contract web dev projects. His Hermes OS / parawi.com is portfolio evidence.",
    effort: "5-20 hrs per project",
    earning: "$15-35/hr at entry level",
    authorization: "Verify with DSO — off-campus freelance may require CPT authorization",
  },
];

// ── gig-scout ─────────────────────────────────────────────────────────────────

export interface GigListing {
  title: string;
  company: string;
  location: string;
  type: string;
  description: string;
  url?: string;
  authorizationNote: string;
}

export async function gigScout(): Promise<GigListing[]> {
  const query = GIG_QUERIES[Math.floor(Math.random() * GIG_QUERIES.length)];
  const listings = await discoverJobs(query, "Austin TX", 8).catch(() => []);

  return listings.map((l) => ({
    title: l.title,
    company: l.company,
    location: l.location ?? "Remote/Austin",
    type: "contract",
    description: (l.description ?? "").slice(0, 300),
    url: l.url,
    authorizationNote: (l.location ?? "").toLowerCase().includes("remote")
      ? "Remote contract — verify CPT with DSO before applying"
      : "On-site — on-campus eligibility depends on employer; verify before applying",
  }));
}

// ── passive-income-scan ───────────────────────────────────────────────────────

export interface PassiveOpportunity {
  title: string;
  description: string;
  effort: string;
  earning: string;
  authorization: string;
}

export function passiveIncomeScan(): PassiveOpportunity[] {
  return PASSIVE_PLAYS;
}

// ── campus-job-scan ───────────────────────────────────────────────────────────

export async function campusJobScan(): Promise<GigListing[]> {
  const campusQueries = [
    "on campus student worker IT Austin Community College",
    "student worker IT UT System Austin",
  ];

  const results = await Promise.all(
    campusQueries.map((q) => discoverJobs(q, "Austin TX", 5).catch(() => []))
  );

  return results.flat().map((l) => ({
    title: l.title,
    company: l.company,
    location: l.location ?? "Austin, TX",
    type: "on-campus",
    description: (l.description ?? "").slice(0, 300),
    url: l.url,
    authorizationNote: "On-campus — F-1 authorized up to 20 hrs/week while school is in session",
  }));
}

// ── income-brief ──────────────────────────────────────────────────────────────
// Synthesizes gig scout + passive scan + campus scan into a short digest.
// LLM call only — no personal data involved (PUBLIC dataClass).

export interface IncomeBriefInput {
  gigs: GigListing[];
  passive: PassiveOpportunity[];
  campusJobs: GigListing[];
}

export interface IncomeBriefResult {
  text: string;
  hasFindings: boolean;
}

const INCOME_BRIEF_SYSTEM_PROMPT = `You are Tyche, the income opportunity scout inside Hermes OS.
Osman is an F-1 international student at ACC in Austin, TX. He works ~19.5 hrs/week on-campus at UT System OCIO (IT support). He has CompTIA Security+ and CySA+, works in I-9/HR compliance daily, and builds web apps (React/TypeScript/Next.js). He is trying to clear ~$5,092 in debt by fall.

Your job: from the gigs and opportunities below, tell him the 2-3 most worth his time this week. Be specific — name the thing, state the pay, state the authorization status, state the time cost. No filler. No em dashes.

Authorization rules you must follow:
- On-campus work: F-1 OK up to 20 hrs/week combined (he already uses 19.5 — flag if that leaves no room).
- Off-campus freelance: requires CPT authorization from his DSO. Say "verify CPT with DSO" for these.
- Passive income (digital products, bounties, research studies): F-1 OK, no authorization needed.`;

function buildBriefPrompt(input: IncomeBriefInput): string {
  const sections: string[] = [];

  if (input.gigs.length) {
    sections.push(
      `Freelance / contract gigs found this scan:\n${input.gigs
        .slice(0, 5)
        .map((g) => `- ${g.title} at ${g.company} (${g.location}) — ${g.description.slice(0, 150)} [${g.authorizationNote}]`)
        .join("\n")}`
    );
  }

  if (input.campusJobs.length) {
    sections.push(
      `On-campus postings found:\n${input.campusJobs
        .slice(0, 4)
        .map((j) => `- ${j.title} at ${j.company} [${j.authorizationNote}]`)
        .join("\n")}`
    );
  }

  sections.push(
    `Standing passive income options (always available):\n${input.passive
      .slice(0, 4)
      .map((p) => `- ${p.title}: ${p.earning} | ${p.effort} | ${p.authorization}`)
      .join("\n")}`
  );

  return `${sections.join("\n\n")}\n\nGive Osman the 2-3 highest-value actions from the above. He has roughly 30 min free this week to act on one thing. Lead with the one you'd do first and why.`;
}

export async function incomeBrief(userId: string): Promise<IncomeBriefResult> {
  const [gigs, campusJobs] = await Promise.all([
    gigScout().catch(() => [] as GigListing[]),
    campusJobScan().catch(() => [] as GigListing[]),
  ]);
  const passive = passiveIncomeScan();

  const input: IncomeBriefInput = { gigs, passive, campusJobs };
  const hasFindings = gigs.length > 0 || campusJobs.length > 0;

  if (!hasFindings) {
    const summary = `Standing passive income options: ${passive.slice(0, 2).map((p) => p.title).join(", ")}. No live gig or campus listings found this scan — check back next week or ask Tyche directly.`;
    await prisma.agentRun.create({
      data: {
        agentName: "tyche",
        inputSummary: "income-brief: no live listings found",
        outputSummary: summary,
        modelProvider: "none",
        status: "completed",
      },
    });
    return { text: summary, hasFindings: false };
  }

  const result = await callModel({
    userId,
    taskType: "tyche-income-brief",
    dataClass: "PUBLIC",
    systemPrompt: INCOME_BRIEF_SYSTEM_PROMPT,
    userPrompt: buildBriefPrompt(input),
  });

  await prisma.agentRun.create({
    data: {
      agentName: "tyche",
      inputSummary: `income-brief: ${gigs.length} gigs, ${campusJobs.length} campus jobs, ${passive.length} passive options`,
      outputSummary: result.text.slice(0, 2000),
      modelProvider: result.provider,
      status: "completed",
    },
  });

  return { text: result.text, hasFindings: true };
}
