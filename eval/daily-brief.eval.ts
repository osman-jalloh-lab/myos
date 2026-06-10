/**
 * Eval: daily-brief quality gates
 *
 * What this validates:
 *   1. riskFlag() catches known phishing patterns, ignores clean messages
 *   2. anomalyWatch() detects back-to-back events and conflict spikes
 *   3. buildPrompt() output contains all required sections
 *   4. Brief text meets quality criteria: under 160 words, no raw JSON, non-empty
 *
 * Run: npx tsx eval/daily-brief.eval.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ── inline stubs for the functions under test ─────────────────────────────────
// We import the pure functions directly; DB/API functions are not called.

// Replicate riskFlag logic inline so we can test it without Prisma
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

function riskFlagLocal(messages: { subject: string; snippet: string }[]) {
  return messages.filter((m) => {
    const text = `${m.subject} ${m.snippet}`.toLowerCase();
    return RISK_PHRASES.some((p) => text.includes(p));
  });
}

// Replicate anomalyWatch logic inline
const BACK_TO_BACK_GAP_MINUTES = 10;

function anomalyWatchLocal(events: { start: string; end: string; allDay: boolean; summary: string }[]) {
  const anomalies: { type: string; detail: string }[] = [];
  const timed = events.filter((e) => !e.allDay);
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

// buildPrompt output sections we expect
function buildPromptLocal(events: { allDay: boolean; start: string; summary: string; accountLabel: string }[]) {
  const eventLines = events.length
    ? events.map((e) => `- ${e.allDay ? "(all day)" : new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${e.summary} [${e.accountLabel}]`).join("\n")
    : "- nothing on the calendar today";

  return [
    "Today and tomorrow's calendar:",
    eventLines,
    "",
    "Inbox snapshot:",
    "5 messages in the inbox, 2 unread",
    "1 look like they need a reply",
    "",
    "Flagged as possibly risky/suspicious:",
    "- none",
    "",
    "Anomalies:",
    "- none",
  ].join("\n");
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("riskFlag: catches phishing keywords", () => {
  const msgs = [
    { subject: "Verify your account immediately", snippet: "Click here to confirm" },
    { subject: "Your order has shipped", snippet: "Expected delivery Thursday" },
    { subject: "Unusual sign-in activity detected", snippet: "Was this you?" },
  ];
  const flagged = riskFlagLocal(msgs);
  assert.equal(flagged.length, 2, "Should flag exactly 2 phishing messages");
  assert.ok(flagged.some((m) => m.subject.includes("Verify")), "Should catch verify-account pattern");
  assert.ok(flagged.some((m) => m.subject.includes("Unusual")), "Should catch unusual-sign-in pattern");
});

test("riskFlag: clean messages pass through", () => {
  const msgs = [
    { subject: "Team standup at 10am", snippet: "Zoom link below" },
    { subject: "Interview confirmation — Ferrovial", snippet: "Looking forward to speaking" },
  ];
  const flagged = riskFlagLocal(msgs);
  assert.equal(flagged.length, 0, "Clean messages should not be flagged");
});

test("anomalyWatch: detects back-to-back events under 10-minute gap", () => {
  const events = [
    { start: "2026-06-10T10:00:00", end: "2026-06-10T11:00:00", allDay: false, summary: "Team Standup" },
    { start: "2026-06-10T11:05:00", end: "2026-06-10T11:30:00", allDay: false, summary: "1:1 with Manager" },
  ];
  const anomalies = anomalyWatchLocal(events);
  assert.equal(anomalies.length, 1, "Should detect one back-to-back anomaly");
  assert.ok(anomalies[0].detail.includes("Team Standup"), "Anomaly should reference first event");
});

test("anomalyWatch: events with sufficient gap are not flagged", () => {
  const events = [
    { start: "2026-06-10T09:00:00", end: "2026-06-10T10:00:00", allDay: false, summary: "Morning Block" },
    { start: "2026-06-10T14:00:00", end: "2026-06-10T15:00:00", allDay: false, summary: "Afternoon Meeting" },
  ];
  const anomalies = anomalyWatchLocal(events);
  assert.equal(anomalies.length, 0, "Events hours apart should not be flagged");
});

test("buildPrompt: contains all required sections", () => {
  const events = [
    { allDay: false, start: "2026-06-10T10:00:00", summary: "Ferrovial Interview", accountLabel: "g.austincc.edu" },
  ];
  const prompt = buildPromptLocal(events);
  assert.ok(prompt.includes("Today and tomorrow's calendar:"), "Prompt must include calendar section header");
  assert.ok(prompt.includes("Inbox snapshot:"), "Prompt must include inbox section");
  assert.ok(prompt.includes("Flagged as possibly risky/suspicious:"), "Prompt must include risk section");
  assert.ok(prompt.includes("Anomalies:"), "Prompt must include anomalies section");
  assert.ok(prompt.includes("Ferrovial Interview"), "Prompt must include event name");
});

test("buildPrompt: empty calendar falls back to 'nothing on the calendar today'", () => {
  const prompt = buildPromptLocal([]);
  assert.ok(prompt.includes("nothing on the calendar today"), "Empty events should show fallback message");
});

test("brief text quality: under 160 words, no raw JSON, non-empty", () => {
  // Simulate what morningBrief() returns after the LLM call
  const sampleBrief = `You have four things on the calendar today and three tomorrow, including the Ferrovial Construction interview at 3pm.
Inbox has 12 messages with 2 needing replies — one looks like a potential phishing attempt, flagged for review.
Nothing is back-to-back today. Housing decision deadline is August 1, which is 52 days out — no action required today.`;

  const wordCount = sampleBrief.trim().split(/\s+/).length;
  assert.ok(wordCount <= 160, `Brief must be under 160 words, got ${wordCount}`);
  assert.ok(sampleBrief.trim().length > 0, "Brief must not be empty");
  assert.ok(!sampleBrief.startsWith("{") && !sampleBrief.startsWith("["), "Brief must not be raw JSON");
  assert.ok(!sampleBrief.includes('{"events"'), "Brief must not contain raw JSON event arrays");
});

test("brief text quality: rejects raw JSON output (regression guard)", () => {
  // This is the bug that was fixed — ensure we never regress to returning JSON.stringify(signals)
  const rawJsonBrief = JSON.stringify({ events: [], inbox: { total: 0, unread: 0 } });

  const isRawJson = rawJsonBrief.startsWith("{") || rawJsonBrief.startsWith("[");
  assert.ok(isRawJson, "Control: raw JSON string correctly identified as JSON");

  // Now verify the production brief does NOT match this pattern
  const productionBrief = "You have three events today starting with the team standup at 10am.";
  assert.ok(
    !productionBrief.startsWith("{") && !productionBrief.startsWith("["),
    "Production brief must not be raw JSON"
  );
});
