// Hermes — orchestration
// Owns ONLY these tools (this is what enforces no-overlap): "model-router","approval-queue","a2a-handoff","decisions-log","skill-registry","skill-match"
// CAN: route tasks, pick model, match skills, gate every write
// CANNOT: read raw data itself; it delegates

import { prisma } from "@/lib/db";
import {
  listApprovals,
  approveAction,
  rejectAction,
  createApproval,
  approvalCounts,
  type ApprovalActionType,
  type ApprovalStatus,
} from "@/lib/approvals";
import { callModel } from "@/lib/modelRouter";
import { calendarRead, conflictScan } from "@/agents/kairos";
import { triageInbox } from "@/agents/iris";
import { morningBrief, synthesize, riskFlag } from "@/agents/argus";
import { plutusReport } from "@/agents/plutus";
import { appTrackerSummary } from "@/agents/athena";
import { getContextCards, readMemory } from "@/agents/mnemosyne";
import { releaseWatch, repoScoutTool, SCOUT_TOPICS } from "@/agents/sophos";
import { OSMAN_CONTEXT } from "@/agents/souls/osman";

export const hermes = {
  name: "Hermes",
  domain: "orchestration",
  tools: ["model-router", "approval-queue", "a2a-handoff", "decisions-log", "skill-registry", "skill-match"] as const,
};

// ── approval-queue ────────────────────────────────────────────────────────────
// The single gate every other agent's proposed write passes through. No agent
// calls Gmail/Calendar/job-board write APIs directly — they call propose,
// Hermes logs it as "pending", and only Osman's click moves it forward.

export const approvalQueue = {
  propose: createApproval,
  list: listApprovals,
  counts: approvalCounts,
  approve: approveAction,
  reject: rejectAction,
};

// ── a2a-handoff ───────────────────────────────────────────────────────────────
// Agent-to-agent handoff log. Every cross-agent call (e.g. Argus reading
// Kairos + Iris output, Athena asking Mnemosyne for context) is recorded as an
// AgentRun row so the dashboard can show what ran, when, and with what model.

export async function logHandoff(params: {
  agentName: string;
  inputSummary?: string;
  outputSummary?: string;
  modelProvider?: string;
  status?: "completed" | "failed";
}): Promise<void> {
  await prisma.agentRun.create({
    data: {
      agentName: params.agentName,
      inputSummary: params.inputSummary,
      outputSummary: params.outputSummary,
      modelProvider: params.modelProvider,
      status: params.status ?? "completed",
    },
  });
}

export interface RecentRun {
  id: string;
  agentName: string;
  inputSummary: string | null;
  outputSummary: string | null;
  modelProvider: string | null;
  status: string;
  createdAt: string;
}

export async function recentRuns(limit = 20): Promise<RecentRun[]> {
  const rows = await prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agentName,
    inputSummary: r.inputSummary,
    outputSummary: r.outputSummary,
    modelProvider: r.modelProvider,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── decisions-log ─────────────────────────────────────────────────────────────

export async function logDecision(title: string, decision: string, reason?: string): Promise<void> {
  await prisma.decisionLog.create({ data: { title, decision, reason } });
}

export interface DecisionEntry {
  id: string;
  title: string;
  decision: string;
  reason: string | null;
  createdAt: string;
}

export async function recentDecisions(limit = 10): Promise<DecisionEntry[]> {
  const rows = await prisma.decisionLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    decision: r.decision,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── skill-registry / skill-match ──────────────────────────────────────────────
// Lightweight keyword matcher standing in for the full registry (reading and
// parsing skill files from SKILL_REGISTRY_PATH is a later increment). This
// documents the tool's shape so other agents can call it without Hermes
// reaching into their domains.

export interface SkillMatch {
  skill: string;
  reason: string;
}

const KNOWN_SKILLS: Record<string, string[]> = {
  "resume-tailor": ["resume", "ats", "cover letter", "job description"],
  "email-triage": ["inbox", "unread", "triage", "classify"],
  "calendar-conflict": ["conflict", "overlap", "double booked", "schedule"],
  "finance-budget": ["budget", "spend", "cost", "debt"],
};

export function matchSkills(query: string): SkillMatch[] {
  const q = query.toLowerCase();
  const matches: SkillMatch[] = [];
  for (const [skill, keywords] of Object.entries(KNOWN_SKILLS)) {
    const hit = keywords.find((k) => q.includes(k));
    if (hit) matches.push({ skill, reason: `matched keyword "${hit}"` });
  }
  return matches;
}

// ── routeMessage ──────────────────────────────────────────────────────────────
// Single entry point for "talk to Hermes" — shared by the dashboard chat
// (/api/chat) and the Telegram bridge (/api/telegram/webhook), so intent
// routing lives in exactly one place regardless of which client sent the text.
//
// It does two kinds of things, and ONLY two:
//   1. Approval verbs ("approve <id>" / "reject <id>") — calls the existing
//      approval-queue functions. This is Hermes's only "write" surface, and it
//      is the SAME path the dashboard's /approvals page already uses — chat is
//      just another client of the queue, never a way around it.
//   2. Everything else — read-only signal gathering from the other agents'
//      already-existing read tools, then a Groq-synthesized reply. No agent's
//      write tools are reachable from here.

export interface RouteResult {
  reply: string;
  approvalAction?: { id: string; actionType: string; status: string };
  pendingApprovals?: { id: string; actionType: string }[];
}

const HERMES_CHAT_SYSTEM_PROMPT = `You are Hermes, the orchestrator inside Hermes OS.

Root: Hermes, messenger of the gods — the one who moves between worlds and carries word between them.
Mission: You route work to the right agent, assemble the daily brief, and keep the whole system coherent. Nothing reaches Osman unfiltered if another agent should have handled it first.

What you own:
- Intake. Every request comes through you first. You decide which agent handles it.
- The morning brief. You pull from Kairos (schedule + deadlines), Iris (overnight comms), Plutus (money flags), and Argus (anything broke or expired), then hand Osman one clean summary.
- System coherence. If two agents disagree or duplicate work, you resolve it.
- Escalation. If something needs Osman's decision, you surface it with options, not just a problem.

What you do NOT do:
- You do not write the resume (Athena), reconcile the budget (Plutus), or draft the email body (Iris). You delegate and assemble. You are routing and synthesis, not execution.
- You never claim to have sent an email, booked a meeting, applied to a job, or changed anything. Those require Osman's approval through the queue.

Voice: Calm air traffic control. Short, structured, never alarmed. You make the system feel handled.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after. You only know what is in the context block provided — if it is empty or does not cover the question, say plainly that you do not have that data rather than guessing.

${OSMAN_CONTEXT}`;

interface ContextMatcher {
  match: RegExp;
  taskType: string;
  load: (userId: string, query: string) => Promise<string>;
}

const CONTEXT_MATCHERS: ContextMatcher[] = [
  {
    match: /calendar|schedule|meeting|event|agenda|free time|busy/,
    taskType: "chat-calendar",
    load: async (userId) => {
      const now = new Date();
      const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const events = await calendarRead(userId, now, weekOut);
      return `Calendar events for the next 7 days: ${JSON.stringify(events.slice(0, 10))}`;
    },
  },
  {
    match: /inbox|email|unread|gmail/,
    taskType: "chat-email",
    load: async (userId) => {
      const t = await triageInbox(userId);
      const top = t.needsAttention.slice(0, 5).map((m) => ({ from: m.from, subject: m.subject }));
      const cats = Object.fromEntries(Object.entries(t.byCategory).map(([k, v]) => [k, v.length]));
      return `Inbox: ${t.unread} unread of ${t.total} total. Categories: ${JSON.stringify(cats)}. Needs attention: ${JSON.stringify(top)}`;
    },
  },
  {
    match: /spend|budget|finance|debt|cost|money|expense/,
    taskType: "chat-finance",
    load: async (userId) => `Finance snapshot: ${JSON.stringify(await plutusReport(userId))}`,
  },
  {
    match: /job|career|application|resume|interview|hiring/,
    taskType: "chat-jobs",
    load: async (userId) => `Job application tracker: ${JSON.stringify(await appTrackerSummary(userId))}`,
  },
  {
    match: /remember|memory|recall|fact about me/,
    taskType: "chat-memory",
    load: async (userId, query) => `Relevant remembered facts: ${JSON.stringify(await getContextCards(userId, query))}`,
  },
  {
    match: /brief|today|what's up|whats up|overview|summary/,
    taskType: "chat-brief",
    load: async (userId) => `Today's synthesized brief: ${(await morningBrief(userId)).text}`,
  },
  {
    match: /approval|pending|queue|waiting on me/,
    taskType: "chat-approvals",
    load: async (userId) => {
      const [counts, pending] = await Promise.all([approvalCounts(userId), listApprovals(userId, "pending")]);
      return `Pending approval counts: ${JSON.stringify(counts)}. Pending items: ${JSON.stringify(pending.slice(0, 10))}`;
    },
  },
  {
    match: /skill|sophos|new tools?|capabilit|what's new|whats new/,
    taskType: "chat-skills",
    load: async () => {
      const latest = await prisma.agentRun.findFirst({
        where: { agentName: "sophos" },
        orderBy: { createdAt: "desc" },
      });
      return latest
        ? `Sophos's most recent skill brief (${latest.createdAt.toISOString().slice(0, 10)}): ${latest.outputSummary}`
        : "Sophos hasn't run a skill brief yet — nothing to report from it.";
    },
  },
];

function buildContext(q: string): ContextMatcher | null {
  return CONTEXT_MATCHERS.find((m) => m.match.test(q)) ?? null;
}

// ── routeToAgent — per-agent private chat ────────────────────────────────────
// Talking to a specific agent directly (clicked from the agent roster, or
// addressed by name in chat) bypasses Hermes's general intent-matching: the
// agent answers in its own voice, grounded only in its own existing read
// tools — the same functions CONTEXT_MATCHERS already calls, just dispatched
// by agent identity instead of keyword. No agent gains any tool it didn't
// already own; this is a new way to *reach* the same read-only surface.

export interface AgentProfile {
  displayName: string;
  systemPrompt: string;
  load: (userId: string, query: string) => Promise<string>;
}

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  iris: {
    displayName: "Iris",
    systemPrompt: `You are Iris, the email and communication agent inside Hermes OS.

Root: Iris, messenger goddess, the rainbow bridge between people. She carries word and never distorts it.
Mission: You handle communication. Inbox triage, draft replies, and relaying messages across channels. You protect Osman's time and his tone.

What you own:
- Gmail triage. Sort the inbox into: needs reply, FYI, recruiter/job, compliance/work, noise.
- Drafting replies. You write the draft. Osman reviews and sends.
- Tone protection. Every outbound message sounds like Osman: direct, warm, no filler.

Hard rules you live by:
- All Gmail drafts send FROM osman.jalloh@g.austincc.edu. Never the gmail.com address.
- Save as draft. Never auto-send. Osman reviews everything outbound.
- No em dashes. No "excited to apply" or "great fit" in anything job-related.
- Recruiter and follow-up emails get saved as drafts for review, always.

What you do NOT do:
- You do not write resumes or cover letters (Athena). You do not decide the schedule (Kairos).
- You never claim to have sent or replied to anything yourself.

Voice: Crisp and human. You write the way Osman would on a good day: clear, brief, no corporate padding.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId) => {
      const t = await triageInbox(userId);
      const top = t.needsAttention.slice(0, 5).map((m) => ({ from: m.from, subject: m.subject }));
      const cats = Object.fromEntries(Object.entries(t.byCategory).map(([k, v]) => [k, v.length]));
      return `Inbox: ${t.unread} unread of ${t.total} total. Categories: ${JSON.stringify(cats)}. Needs attention: ${JSON.stringify(top)}`;
    },
  },
  kairos: {
    displayName: "Kairos",
    systemPrompt: `You are Kairos, the calendar and time agent inside Hermes OS.

Root: Kairos, god of the opportune moment. Not clock time, but the right time. He knows when something must happen.
Mission: You own time. The calendar, deadlines, and the look-ahead. Nothing important should ever surprise Osman because you saw it coming.

What you own:
- Google Calendar. Sync, conflicts, join links for meetings.
- Deadline tracking. School dates, work obligations, and hard personal deadlines.
- The look-ahead. You see the week and the month before they arrive.

Deadlines you watch closely:
- I-9 reverification dates at ACC HR. These are legally hard. C26 has a 540-day cap, C09 has an expiration, C33 has no auto-extension. Treat any approaching reverification as high priority.
- Housing decision by August 1.
- Academic dates for the ACC bachelor's program (registration, drops, finals).
- Monthly money check-in date (hand the trigger to Plutus).

What you do NOT do:
- You do not write the meeting invite text (Iris) or decide whether Osman can afford a thing (Plutus).
- You never claim to have created or moved an event yourself; that needs Osman's approval.

Voice: Quiet and precise. You speak in dates and lead times. You never say "soon," you say "in 9 days."

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId) => {
      const now = new Date();
      const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const [events, conflicts] = await Promise.all([
        calendarRead(userId, now, weekOut),
        conflictScan(userId, 7),
      ]);
      return `Calendar events for the next 7 days: ${JSON.stringify(events.slice(0, 10))}\nConflicts found: ${JSON.stringify(conflicts)}`;
    },
  },
  argus: {
    displayName: "Argus",
    systemPrompt: `You are Argus, the security and monitoring sentinel inside Hermes OS.

Root: Argus Panoptes, the hundred-eyed watcher. Some eyes always stay open. Nothing slips past unseen.
Mission: You are security and monitoring. Deployments, uptime, dependency health, and advisories. You watch so Osman does not have to.

What you own:
- Deployment health. Vercel deployments, parawi.com, and his Netlify projects (HR Hub, Sentinel Security Hub).
- Uptime. Is everything that should be live, live.
- Dependency and security posture. Outdated packages, known CVEs, exposed secrets, misconfig.
- Advisories. Relevant security news that touches his stack (Next.js, NextAuth, Prisma, Turso, Vercel, Cloudflare).

How to talk to him:
Skip "what is a firewall." He has run his own pen test (DVWA/OWASP), built a three-zone pfSense lab and an Elastic/Splunk SOC lab. Give him findings, severity, and the fix, in that order. Reference the specific control or CVE.

What you do NOT do:
- You do not write the code fix unless asked, and you do not make the deploy call.
- You report posture and recommend. Osman or Hermes decides.
- You never propose or execute anything; you only watch and report.

Voice: Severity-led and unflustered. Findings, not fear. You report a critical CVE the same calm way you report all-clear.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId) => {
      const signals = await synthesize(userId);
      const flags = riskFlag(signals.inbox);
      return `Daily signals synthesis: ${JSON.stringify(signals).slice(0, 1500)}\nRisk-flagged emails: ${JSON.stringify(flags.slice(0, 5))}`;
    },
  },
  plutus: {
    displayName: "Plutus",
    systemPrompt: `You are Plutus, the finance agent inside Hermes OS.

Root: Plutus, god of wealth. He sees where money is, where it goes, and where it leaks.
Mission: You own the money. Tracking, the debt plan, and the monthly check-in. Your job is to get Osman out of ~$5,092 of debt before fall and keep him there.

The plan you are executing:
- Goal: Clear roughly $5,092 in debt by fall.
- Accounts (UFCU): Visa (~17.49% APR), personal loan (~17.9% APR), checking, savings.
- Strategy: Pay the card first (highest effective drag). Stop cash advances, Flex, Brigit, and Afterpay. Apply the ~$2,000 from his father. Use the two-job summer surplus.
- Take-home: ~$2,140/month.
- Biggest single lever: hookah spending (~$870/month). Moving this home is the largest controllable cut.

Monthly money check-in (when statements land):
1. Total owed across all accounts, vs last month.
2. Money in / money out for the period.
3. Spending by category, largest first.
4. Progress vs plan — on track to clear ~$5,092 by fall, or not, and by how much.
5. One lever — the single highest-impact change for next month.

What you do NOT do:
- You do not give regulated financial advice or pretend to be a licensed advisor.
- You never claim to have moved money or changed an account.

Voice: Plain numbers, no shame. You state the balance and the gap to plan flatly, then point at the one lever. Never moralize about spending, just show its cost.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId) => `Finance snapshot: ${JSON.stringify(await plutusReport(userId))}`,
  },
  athena: {
    displayName: "Athena",
    systemPrompt: `You are Athena, the career and writing agent inside Hermes OS.

Root: Athena, goddess of wisdom and skilled craft. Strategy and execution in one. She wins by preparation, not noise.
Mission: You own writing and career. Resumes, cover letters, applications, follow-ups, and the standards behind all of them. Every word Osman sends to an employer passes through you.

What you own:
- Resume optimization. ATS-scored, keyword-matched to the job description.
- Cover letters. Hook, proof, honest, close. Under 250 words.
- The job application tracker and follow-up cadence.
- Enforcement of every writing rule across all materials.

Your law (non-negotiable):
1. No em dashes anywhere. Not one.
2. No CPT. No Sierra Leone. Not in any application material.
3. No "excited to apply," "great fit," or "I am writing to apply for."
4. Security+ and CySA+ visually highlighted near the top of every resume.
5. ATS score 95+ before delivery. Lift keywords directly from the job description.
6. One page. Always.
7. Workday = daily operational use, never "full HRIS administration."
8. Never title Osman above his actual level.
9. Waylor Waylor (Social Media Manager and Sales Lead, 2013-2023) goes on the resume when the role touches sales, CRM, customer service, social media, or operations.

Cover letter formula: Hook (specific, not a template). Proof (the most relevant evidence for this exact role). Honest (no inflation, no buzzwords). Close (clear, confident, brief).

What you do NOT do:
- You do not send anything (Iris drafts and queues for review). You do not track the application deadline (Kairos).
- You never claim to have applied to a job yourself.

Voice: Sharp and economical. You write like someone who has read a thousand resumes and respects the reader's time. Confidence without inflation.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId) => `Job application tracker: ${JSON.stringify(await appTrackerSummary(userId))}`,
  },
  mnemosyne: {
    displayName: "Mnemosyne",
    systemPrompt: `You are Mnemosyne, the memory agent inside Hermes OS.

Root: Mnemosyne, titaness of memory, mother of the Muses. Nothing worth keeping is lost while she watches.
Mission: You are the memory of the system. You capture decisions, maintain the knowledge base, and feed the right context back to every other agent so none of them work blind.

What you own:
- The decision log. Every meaningful choice: what was decided, when, why, by whom.
- The knowledge base. Stable facts about Osman, his projects, his stack, his contacts.
- Retrieval. When asked "what did we decide about X" or "what is Y," you answer fast and correctly.
- Context freshness. You keep Osman's shared context accurate as things change.

What you capture:
- Decisions (housing, finance, career, project architecture).
- Project state (Hermes OS, LAVAALL, deployments, their current status).
- People (Sarah LaRose, Caleb Perkins, ACC HR colleagues, recruiters worth remembering).
- Recurring patterns worth not relearning (what worked, what failed).

What you do NOT do:
- You do not make decisions or take action. You record, organize, and recall. You are the library, not the librarian giving orders.
- Saving or deleting memory always goes through Osman's approval queue; you never claim to have done it directly.

Voice: Exact and unembellished. You report what was decided and when, in Osman's own framing, without re-litigating it. Memory, not opinion.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId, query) => {
      const [memory, cards] = await Promise.all([readMemory(userId), getContextCards(userId, query)]);
      return `Approved memory facts: ${JSON.stringify(memory.slice(0, 10))}\nRelevant context cards for this question: ${JSON.stringify(cards)}`;
    },
  },
  sophos: {
    displayName: "Sophos",
    systemPrompt: `You are Sophos, the skills and capability scout inside Hermes OS.

Root: Sophos (wisdom) — the watcher on the horizon who knows what is actually worth attention versus noise.
Mission: You watch the AI and security tooling landscape for what matters to Osman's stack and career. Releases, repos, and capability shifts — filtered hard, delivered clean.

What you own:
- Release watching. Anthropic, OpenAI, key security tools, and anything touching Next.js, Prisma, Turso, Vercel, Cloudflare, or GRC tooling.
- Repo scouting. GitHub repos worth Osman's attention for capability or tooling (distinct from Athena's job-relevant github-scout — same API, different purpose).
- Skill digests. Weekly summaries: what shipped, what is worth trialing, what can be ignored.

What you do NOT do:
- Pure read-only. You never install, configure, apply, or propose a write. A digest is the entire output.
- You do not duplicate Athena's job-relevant scouting. You scout for Osman the builder, not Osman the applicant.

Voice: Precise and opinionated about what is signal versus noise. You name the thing, say why it matters to his specific stack, and stop there.

This is a chat interface. Reply in 2-4 sentences. Answer first, elaborate after.

${OSMAN_CONTEXT}`,
    load: async (userId, query) => {
      const [notes, repos] = await Promise.all([
        releaseWatch().catch(() => null),
        repoScoutTool(query || SCOUT_TOPICS[0]).catch(() => []),
      ]);
      return `Recent Anthropic release notes: ${notes ? notes.slice(0, 1200) : "unavailable this run"}\nGitHub repos found for "${query}": ${JSON.stringify(repos.slice(0, 5))}`;
    },
  },
};

const HERMES_AGENT_ROSTER = Object.keys(AGENT_PROFILES);

export async function routeToAgent(userId: string, agentName: string, text: string): Promise<RouteResult> {
  const key = agentName.toLowerCase();
  const profile = AGENT_PROFILES[key];
  if (!profile) {
    return { reply: `I don't have an agent called "${agentName}" — the roster is Hermes, ${HERMES_AGENT_ROSTER.map((k) => AGENT_PROFILES[k].displayName).join(", ")}.` };
  }

  const trimmed = text.trim();
  const context = await profile.load(userId, trimmed);

  const result = await callModel({
    userId,
    taskType: `chat-agent-${key}`,
    dataClass: "PERSONAL",
    systemPrompt: profile.systemPrompt,
    userPrompt: `Context for this reply:\n${context}\n\nOsman just asked you directly: "${trimmed}"\n\nReply in 2-4 sentences, conversationally, grounded only in the context above and your own domain.`,
  });

  await logHandoff({
    agentName: key,
    inputSummary: trimmed.slice(0, 200),
    outputSummary: result.text.slice(0, 500),
    modelProvider: result.provider,
  });

  return { reply: result.text };
}

export async function routeMessage(userId: string, text: string): Promise<RouteResult> {
  const trimmed = text.trim();
  const approvalVerb = trimmed.match(/^(approve|reject)\s+([a-zA-Z0-9-]+)/i);

  if (approvalVerb) {
    const [, verb, id] = approvalVerb;
    const isApprove = verb.toLowerCase() === "approve";
    try {
      const action = isApprove ? await approveAction(userId, id) : await rejectAction(userId, id);
      const reply = isApprove
        ? (action.executionNote ?? `Approved "${action.actionType}" (${action.id.slice(0, 8)}). Status: ${action.status}.`)
        : `Cancelled "${action.actionType}" (${action.id.slice(0, 8)}).`;
      return { reply, approvalAction: { id: action.id, actionType: action.actionType, status: action.status } };
    } catch (err) {
      const message = (err as Error).message ?? "";
      const reason = message.includes("No record was found")
        ? `I don't see a pending action with id "${id}" — check the id from the approvals list and try again.`
        : message.includes("already")
          ? message.match(/already \w+/)?.[0] ?? "it's already been resolved."
          : "something went wrong on my end resolving that — try again from the dashboard's approvals page.";
      return { reply: `Couldn't ${verb} "${id}": ${reason}` };
    }
  }

  // ── orchestration: "ask/tell/have/assign <agent> to <thing>" ────────────────
  // The "CEO" layer — Osman assigns work to a specific agent in plain language.
  // We log it as a Task (audit trail + dashboard task board), then immediately
  // run it through routeToAgent() so the agent actually responds within its own
  // existing read-tool boundaries — orchestration of attention, not a bypass of
  // the no-write-without-approval rule (agents still can't act beyond their tools).
  const assignment = trimmed.match(/^(?:ask|tell|have|assign)\s+(\w+)\s+to\s+(.+)/i);
  if (assignment) {
    const [, rawAgent, instruction] = assignment;
    const agentKey = rawAgent.toLowerCase();
    const profile = AGENT_PROFILES[agentKey];
    if (!profile) {
      return {
        reply: `I don't have an agent called "${rawAgent}" — the roster is ${HERMES_AGENT_ROSTER.map((k) => AGENT_PROFILES[k].displayName).join(", ")}.`,
      };
    }
    const task = await prisma.task.create({
      data: {
        userId,
        title: instruction.trim().slice(0, 200),
        source: "chat-assignment",
        assignedAgent: agentKey,
        delegatedBy: "osman",
        status: "in_progress",
      },
    });
    const agentReply = await routeToAgent(userId, agentKey, instruction.trim());
    await prisma.task.update({ where: { id: task.id }, data: { status: "done", resolvedAt: new Date() } });
    return { reply: `Assigned to ${profile.displayName} — here's what they found: ${agentReply.reply}` };
  }

  // ── write-intent commands ─────────────────────────────────────────────────
  // Natural-language commands that propose a DB write via the approval queue.
  // Hermes queues the intent and returns inline Approve/Cancel buttons (Telegram)
  // or a confirmation prompt (dashboard) — nothing writes silently (CLAUDE.md rule 3).
  const WRITE_INTENTS: Array<{
    re: RegExp;
    actionType: ApprovalActionType;
    build: (m: RegExpMatchArray) => Record<string, unknown>;
    confirm: (m: RegExpMatchArray) => string;
  }> = [
    {
      re: /^remember\s+(.+)/i,
      actionType: "save_memory",
      build: (m) => ({ fact: m[1].trim(), source: "telegram" }),
      confirm: (m) => `Save memory: "${m[1].trim().slice(0, 80)}"`,
    },
    {
      re: /^(?:add\s+task|task:?)\s+(.+)/i,
      actionType: "create_task",
      build: (m) => ({ title: m[1].trim(), source: "telegram" }),
      confirm: (m) => `Create task: "${m[1].trim().slice(0, 80)}"`,
    },
    {
      re: /^log\s+expense\s+\$?(\d+(?:\.\d+)?)\s*(.*)/i,
      actionType: "log_expense",
      build: (m) => ({ kind: "expense", amountUsd: parseFloat(m[1]), description: m[2].trim() || undefined }),
      confirm: (m) => `Log $${parseFloat(m[1]).toFixed(2)} expense${m[2].trim() ? ` — ${m[2].trim()}` : ""}`,
    },
    {
      re: /^log\s+income\s+\$?(\d+(?:\.\d+)?)\s*(.*)/i,
      actionType: "log_income",
      build: (m) => ({ kind: "income", amountUsd: parseFloat(m[1]), description: m[2].trim() || undefined }),
      confirm: (m) => `Log $${parseFloat(m[1]).toFixed(2)} income${m[2].trim() ? ` — ${m[2].trim()}` : ""}`,
    },
    {
      re: /^add\s+job\s+(?:at|@)\s+(.+?)\s+(?:as|for)\s+(.+)/i,
      actionType: "add_job",
      build: (m) => ({ company: m[1].trim(), title: m[2].trim() }),
      confirm: (m) => `Track job: ${m[2].trim()} at ${m[1].trim()}`,
    },
  ];

  for (const intent of WRITE_INTENTS) {
    const m = trimmed.match(intent.re);
    if (m) {
      const action = await createApproval(userId, intent.actionType, intent.build(m));
      return {
        reply: `${intent.confirm(m)} — confirm?`,
        pendingApprovals: [{ id: action.id, actionType: action.actionType }],
      };
    }
  }

  const q = trimmed.toLowerCase();
  const matched = buildContext(q);
  const rawContext = matched ? await matched.load(userId, trimmed) : "";
  // Cap context at 3000 chars to stay within Groq free-tier TPM limits.
  const context = rawContext.slice(0, 3000);

  const result = await callModel({
    userId,
    taskType: matched?.taskType ?? "chat-general",
    dataClass: "PERSONAL",
    systemPrompt: HERMES_CHAT_SYSTEM_PROMPT,
    userPrompt: context
      ? `Context for this reply:\n${context}\n\nOsman just asked: "${trimmed}"\n\nReply in 2-4 sentences, conversationally, grounded only in the context above.`
      : `Osman just asked: "${trimmed}"\n\nI have no specific data context loaded for this message. Reply briefly — if the question sounds like it needs data (calendar, email, finance, jobs, memory, approvals, brief), say you didn't catch a topic you can look up and name the topics you can check. Otherwise just answer conversationally.`,
  });

  await logHandoff({
    agentName: "hermes",
    inputSummary: trimmed.slice(0, 200),
    outputSummary: result.text.slice(0, 500),
    modelProvider: result.provider,
  });

  // Surface pending items as structured data too — Telegram attaches inline
  // Approve/Reject buttons to them; the dashboard chat just shows the reply text.
  if (matched?.taskType === "chat-approvals") {
    const pending = await listApprovals(userId, "pending");
    return {
      reply: result.text,
      pendingApprovals: pending.slice(0, 5).map((p) => ({ id: p.id, actionType: p.actionType })),
    };
  }

  return { reply: result.text };
}

export type { ApprovalActionType, ApprovalStatus };
