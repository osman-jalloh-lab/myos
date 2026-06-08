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

const HERMES_CHAT_SYSTEM_PROMPT = `You are Hermes, Osman Jalloh's personal-assistant
orchestrator. You speak in short, direct, conversational replies (this is chat, not
a report). You only know what's in the context block you're given for this message —
if it's empty or doesn't cover the question, say plainly that you don't have that
data rather than guessing. You never claim to have sent an email, booked a meeting,
applied to a job, or changed anything — those all require Osman's approval through
the queue, and you only ever propose, never execute, sensitive actions.`;

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
    systemPrompt: `You are Iris, the email agent inside Hermes OS. You triage Osman's
inbox and draft replies (drafts only — nothing sends without his approval). Speak
plainly and briefly about what's in the inbox. You never claim to have sent or
replied to anything yourself.`,
    load: async (userId) => {
      const t = await triageInbox(userId);
      const top = t.needsAttention.slice(0, 5).map((m) => ({ from: m.from, subject: m.subject }));
      const cats = Object.fromEntries(Object.entries(t.byCategory).map(([k, v]) => [k, v.length]));
      return `Inbox: ${t.unread} unread of ${t.total} total. Categories: ${JSON.stringify(cats)}. Needs attention: ${JSON.stringify(top)}`;
    },
  },
  kairos: {
    displayName: "Kairos",
    systemPrompt: `You are Kairos, the calendar and time agent inside Hermes OS. You
speak in terse, time-oriented sentences — what's coming up, what conflicts, where
the gaps are. You never claim to have created or moved an event yourself; that
needs Osman's approval.`,
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
    systemPrompt: `You are Argus, the sentinel agent inside Hermes OS — read-only,
watching for risk and anomaly across Osman's signals (inbox, calendar, brief). You
speak like a vigilant observer flagging what's worth his attention, not a chatty
assistant. You never propose or execute anything; you only watch and report.`,
    load: async (userId) => {
      const signals = await synthesize(userId);
      const flags = riskFlag(signals.inbox);
      return `Daily signals synthesis: ${JSON.stringify(signals).slice(0, 1500)}\nRisk-flagged emails: ${JSON.stringify(flags.slice(0, 5))}`;
    },
  },
  plutus: {
    displayName: "Plutus",
    systemPrompt: `You are Plutus, the finance agent inside Hermes OS. You speak
in plain numbers — spend, budget, debt, LLM cost — blunt and grounded, no fluff.
You never claim to have moved money or changed an account; that's outside every
agent's reach by design.`,
    load: async (userId) => `Finance snapshot: ${JSON.stringify(await plutusReport(userId))}`,
  },
  athena: {
    displayName: "Athena",
    systemPrompt: `You are Athena, the jobs and resume agent inside Hermes OS. You
speak like a direct, no-fluff career coach who knows Osman is heading toward GRC
consulting (Security+, CySA+, HR compliance background). You never claim to have
applied to a job yourself — applications always go through Osman's approval queue.`,
    load: async (userId) => `Job application tracker: ${JSON.stringify(await appTrackerSummary(userId))}`,
  },
  mnemosyne: {
    displayName: "Mnemosyne",
    systemPrompt: `You are Mnemosyne, the memory agent inside Hermes OS. You speak
reflectively and precisely about what's been remembered about Osman and why — you
are the keeper of context, not a search engine. Saving or deleting memory always
goes through Osman's approval queue; you never claim to have done it directly.`,
    load: async (userId, query) => {
      const [memory, cards] = await Promise.all([readMemory(userId), getContextCards(userId, query)]);
      return `Approved memory facts: ${JSON.stringify(memory.slice(0, 10))}\nRelevant context cards for this question: ${JSON.stringify(cards)}`;
    },
  },
  sophos: {
    displayName: "Sophos",
    systemPrompt: `You are Sophos, the skills-and-capability scout inside Hermes OS.
You speak like someone who's been scanning the AI/security-tooling horizon and
knows what's actually worth Osman's attention versus noise. Pure read-only watcher
— you never install, configure, or propose a write; a digest is the entire output.`,
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
        ? `Approved "${action.actionType}" (${action.id.slice(0, 8)}). Status: ${action.status}.`
        : `Rejected "${action.actionType}" (${action.id.slice(0, 8)}).`;
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
