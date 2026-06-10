/**
 * Eval: multi-agent routing
 *
 * Tests that MULTI_AGENT_ROUTES fire on the right queries and stay silent on
 * single-domain queries — so the fast CONTEXT_MATCHERS path isn't bypassed
 * unnecessarily.
 *
 * Run: npx tsx --test eval/multi-agent.eval.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Inline the route patterns so we can test them without importing Prisma/DB
const MULTI_AGENT_ROUTES = [
  {
    label: "interview-prep",
    match: /\b(prep|prepare|get ready for|ready for).*(interview|meeting|presentation|call)\b/i,
    agents: ["kairos", "athena", "mnemosyne"],
  },
  {
    label: "plan-week-day",
    match: /\b(plan|planning)\s+(my\s+)?(week|day|tomorrow)\b|\bwhat should i (focus|do|work on)\b/i,
    agents: ["kairos", "iris", "argus"],
  },
  {
    label: "big-picture",
    match: /\b(big picture|full overview|how am i doing|catch me up|status check|where am i at)\b/i,
    agents: ["argus", "kairos", "iris", "plutus"],
  },
  {
    label: "on-track",
    match: /\bam i on track\b|\bwhat'?s left\b|\b(week|weekly) recap\b|\bend of (the )?(week|day)\b/i,
    agents: ["kairos", "athena", "plutus"],
  },
];

function findRoute(q: string) {
  return MULTI_AGENT_ROUTES.find((r) => r.match.test(q)) ?? null;
}

// ── multi-agent triggers ──────────────────────────────────────────────────────

test("multi-agent: 'prep for my interview tomorrow' routes to kairos+athena+mnemosyne", () => {
  const route = findRoute("prep for my interview tomorrow");
  assert.ok(route, "Should match a multi-agent route");
  assert.equal(route.label, "interview-prep");
  assert.ok(route.agents.includes("kairos"), "Should include kairos");
  assert.ok(route.agents.includes("athena"), "Should include athena");
  assert.ok(route.agents.includes("mnemosyne"), "Should include mnemosyne");
});

test("multi-agent: 'get ready for the Ferrovial call' fires interview-prep route", () => {
  const route = findRoute("get ready for the Ferrovial call");
  assert.ok(route, "Should match");
  assert.equal(route.label, "interview-prep");
});

test("multi-agent: 'help me plan my week' routes to kairos+iris+argus", () => {
  const route = findRoute("help me plan my week");
  assert.ok(route, "Should match a multi-agent route");
  assert.equal(route.label, "plan-week-day");
  assert.ok(route.agents.includes("kairos"), "Should include kairos");
  assert.ok(route.agents.includes("iris"), "Should include iris");
  assert.ok(route.agents.includes("argus"), "Should include argus");
});

test("multi-agent: 'what should I focus on today' fires plan route", () => {
  const route = findRoute("what should I focus on today");
  assert.ok(route, "Should match");
  assert.equal(route.label, "plan-week-day");
});

test("multi-agent: 'big picture' routes all four agents", () => {
  const route = findRoute("give me the big picture");
  assert.ok(route, "Should match big-picture route");
  assert.equal(route.agents.length, 4, "Big picture should fan out to 4 agents");
});

test("multi-agent: 'catch me up' fires big-picture route", () => {
  const route = findRoute("catch me up on everything");
  assert.ok(route, "Should match");
  assert.equal(route.label, "big-picture");
});

test("multi-agent: 'am I on track' routes to kairos+athena+plutus", () => {
  const route = findRoute("am I on track to clear my debt?");
  assert.ok(route, "Should match on-track route");
  assert.equal(route.label, "on-track");
});

test("multi-agent: 'end of week recap' fires on-track route", () => {
  const route = findRoute("end of week recap");
  assert.ok(route, "Should match");
  assert.equal(route.label, "on-track");
});

// ── single-domain queries should NOT trigger multi-agent ─────────────────────

test("multi-agent: 'what's my schedule today' does NOT fire multi-agent", () => {
  const route = findRoute("what's my schedule today");
  assert.equal(route, null, "Simple calendar query should stay single-agent");
});

test("multi-agent: 'check my inbox' does NOT fire multi-agent", () => {
  const route = findRoute("check my inbox");
  assert.equal(route, null, "Simple email query should stay single-agent");
});

test("multi-agent: 'how much debt do I have' does NOT fire multi-agent", () => {
  const route = findRoute("how much debt do I have");
  assert.equal(route, null, "Simple finance query should stay single-agent");
});

test("multi-agent: greetings do NOT fire multi-agent", () => {
  assert.equal(findRoute("hey hermes"), null);
  assert.equal(findRoute("good morning"), null);
  assert.equal(findRoute("thanks"), null);
});
