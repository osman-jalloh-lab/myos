// Argus — sentinel & daily brief
// Owns ONLY these tools (this is what enforces no-overlap):
//   synthesize | risk-flag | anomaly-watch | morning-brief
// CAN:  read every other agent's output, build the morning brief, flag risks
// CANNOT: hold any action tool — pure read-only watcher (the security-guard role)

import { prepNotes, conflictScan, type ConflictScanResult } from "./kairos";
import { triageInbox } from "./iris";
import type { CalendarEvent } from "@/lib/calendar";
import type { EmailMessage, TriageResult } from "@/lib/gmail";
import { callModel } from "@/lib/modelRouter";
import { prisma } from "@/lib/db";

export const argus = {
  name: "Argus",
  domain: "sentinel & brief",
  tools: ["synthesize", "risk-flag", "anomaly-watch", "morning-brief"] as const,
};

// ── synthesize ────────────────────────────────────────────────────────────────
// Pure aggregation of today's signals from Kairos and Iris. No LLM call —
// Argus only reaches the model router inside morning-brief.

export interface DailySignals {
  events: CalendarEvent[];
  conflicts: ConflictScanResult;
  inbox: TriageResult;
}

export async function synthesize(userId: string): Promise<DailySignals> {
  const [events, conflicts, inbox] = await Promise.all([
    prepNotes(userId, 2), // today + tomorrow
    conflictScan(userId, 2),
    triageInbox(userId),
  ]);
  return { events, conflicts, inbox };
}

// ── risk-flag ─────────────────────────────────────────────────────────────────
// Heuristic phishing/scam-pattern scan over message metadata. No LLM — keeps
// the security-guard role cheap, fast, and not dependent on a cloud call.

const RISK_PHRASES = [
  "verify your account",
  "suspended",
  "confirm your password",
  "unusual sign-in activity",
  "wire transfer",
  "gift card",
  "act now",
  "your account will be closed",
  "click here immediately",
];

export function riskFlag(inbox: TriageResult): EmailMessage[] {
  const all = Object.values(inbox.byCategory).flat();
  return all.filter((m) => {
    const text = `${m.subject} ${m.snippet}`.toLowerCase();
    return RISK_PHRASES.some((phrase) => text.includes(phrase));
  });
}

// ── anomaly-watch ─────────────────────────────────────────────────────────────
// Heuristic thresholds over today's signals — no LLM, no historical baseline yet.

export interface Anomaly {
  type: "conflict_spike" | "unread_spike" | "back_to_back";
  detail: string;
}

const UNREAD_SPIKE_THRESHOLD = 20;
const BACK_TO_BACK_GAP_MINUTES = 10;

export function anomalyWatch(signals: DailySignals): Anomaly[] {
  const anomalies: Anomaly[] = [];

  if (signals.conflicts.conflictCount > 0) {
    anomalies.push({
      type: "conflict_spike",
      detail: `${signals.conflicts.conflictCount} overlapping event group(s) today`,
    });
  }

  if (signals.inbox.unread > UNREAD_SPIKE_THRESHOLD) {
    anomalies.push({
      type: "unread_spike",
      detail: `${signals.inbox.unread} unread messages across linked accounts`,
    });
  }

  const timed = signals.events.filter((e) => !e.allDay);
  for (let i = 0; i < timed.length - 1; i++) {
    const gapMinutes =
      (new Date(timed[i + 1].start).getTime() - new Date(timed[i].end).getTime()) / 60_000;
    if (gapMinutes >= 0 && gapMinutes < BACK_TO_BACK_GAP_MINUTES) {
      anomalies.push({
        type: "back_to_back",
        detail: `"${timed[i].summary}" runs straight into "${timed[i + 1].summary}"`,
      });
    }
  }

  return anomalies;
}

// ── morning-brief ─────────────────────────────────────────────────────────────
// Synthesizes the day's signals into short prose via the model router, then
// upserts the result into daily_briefs (one per user per day).
//
// dataClass is PRIVATE: email metadata is in the prompt, so this must never be
// routed to a general cloud model — the router sends it to Groq (or Ollama, if
// OLLAMA_BASE_URL is configured), per HERMES_OS_MASTER_SPEC.md section 4.

export interface MorningBrief {
  date: string;
  text: string;
  signals: DailySignals;
  risks: EmailMessage[];
  anomalies: Anomaly[];
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function buildPrompt(signals: DailySignals, risks: EmailMessage[], anomalies: Anomaly[]): string {
  const eventLines = signals.events.length
    ? signals.events
        .map((e) => `- ${e.allDay ? "(all day)" : formatTime(e.start)} ${e.summary} [${e.accountLabel}]`)
        .join("\n")
    : "- nothing on the calendar today";

  const inboxLines = [
    `${signals.inbox.total} messages in the inbox, ${signals.inbox.unread} unread`,
    `${signals.inbox.byCategory.action_needed.length} look like they need a reply`,
  ].join("\n");

  const riskLines = risks.length
    ? risks.map((m) => `- "${m.subject}" from ${m.from} [${m.accountLabel}]`).join("\n")
    : "- none";

  const anomalyLines = anomalies.length
    ? anomalies.map((a) => `- ${a.detail}`).join("\n")
    : "- none";

  return [
    "Today and tomorrow's calendar:",
    eventLines,
    "",
    "Inbox snapshot:",
    inboxLines,
    "",
    "Flagged as possibly risky/suspicious:",
    riskLines,
    "",
    "Anomalies:",
    anomalyLines,
  ].join("\n");
}

const BRIEF_SYSTEM_PROMPT =
  "You are Argus, a calm and factual morning-briefing assistant. Write a short " +
  "(under 160 words) plain-prose summary covering today and tomorrow from the structured " +
  "signals given. No greetings, no filler, no markdown headers or bullet lists — " +
  "just direct prose. Highlight any interviews, meetings, or deadlines coming up. " +
  "Call out conflicts, anything flagged as risky, and anomalies if present; otherwise say the day looks clear.";

export async function morningBrief(userId: string): Promise<MorningBrief> {
  const signals = await synthesize(userId);
  const risks = riskFlag(signals.inbox);
  const anomalies = anomalyWatch(signals);

  const { text } = await callModel({
    userId,
    taskType: "daily-brief",
    dataClass: "PRIVATE",
    systemPrompt: BRIEF_SYSTEM_PROMPT,
    userPrompt: buildPrompt(signals, risks, anomalies),
  });

  const briefDate = new Date();
  briefDate.setHours(0, 0, 0, 0);

  await prisma.dailyBrief.upsert({
    where: { userId_briefDate: { userId, briefDate } },
    update: { content: JSON.stringify({ text, risks, anomalies }) },
    create: { userId, briefDate, content: JSON.stringify({ text, risks, anomalies }) },
  });

  return { date: briefDate.toISOString(), text, signals, risks, anomalies };
}
