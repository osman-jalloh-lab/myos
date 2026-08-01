# Decisions log

## 2026-08-01 — Establish one Hermes OS integration baseline

Decision: Treat the local `hermes-os` repository as the candidate integration baseline while
reconciling it with `osman-jalloh-lab/myos`. Freeze all other Hermes variants as read-only
sources. Port variant features one at a time with tests and provenance. Do not bulk-copy trees,
delete variants, or force-push GitHub main.

Why: The workspace contains divergent repositories with identical dependencies. The larger local
tree contains capabilities absent from smaller variants, while GitHub main shares the smaller
lineage. A controlled consolidation branch is safer than selecting a repository by folder name
or file count alone.

Owner: Osman Jalloh.

## 2026-06-07 — Phases 4-7 complete: approval queue, Plutus, Athena, Mnemosyne, scheduled automation — all verified live
Built and verified end-to-end, all gated by the approval queue per CLAUDE.md rule 3
("nothing writes silently"):

- **Phase 4 — Approval queue.** src/lib/approvals.ts (ApprovalAction state machine
  pending->approved|rejected|executed; SCOPE_BLOCKED documents why draft_email/send_email/
  create_event/label_email/apply_to_job stay "approved — execution held" until scopes exist;
  create_task/save_memory/delete_memory execute immediately as internal-DB-only writes),
  /api/approvals + /api/approvals/[id], and /approvals UI (counts, tabs, approve/reject forms).
- **Phase 5 — Plutus (finance & spend).** src/lib/finance.ts + src/agents/plutus.ts implement
  finance.read, budget-cap, llm-cost-monitor, debt-tracker over a new FinanceEntry table
  (manual ledger — Plutus never moves money) and the real ModelUsage rows Argus has been
  logging since Phase 2. Live-verified: llmCostMonitor aggregated 6 real groq/daily-brief
  rows ($0.0000972 of a $10 MONTHLY_BUDGET_CAP, 0.001% used, level "ok").
- **Phase 5 — Athena (career & jobs).** src/lib/jobs.ts + src/agents/athena.ts implement
  job-search/app-tracker over a new JobListing table, github-scout via the public GitHub
  search API (PUBLIC data, no auth, read-only), and fit-score/skill-gap/resume-tailor/
  ats-optimize/cover-letter as real Groq calls (dataClass PERSONAL) honoring Osman's writing
  rules (no em dashes, Security+/CySA+ near top, never over-title). Live-verified: a real
  fitScore call scored a sample GRC Analyst posting 82/100 with honest reasoning, logged to
  model_usage ($0.000021); githubScout returned real GRC/compliance repos; JobListing CRUD
  round-tripped (create -> status update -> fitScore -> delete).
- **Mnemosyne (memory).** src/lib/memory.ts + src/agents/mnemosyne.ts implement memory.read,
  memory-suggest, context-cards (keyword-overlap ranking, no LLM needed), stale-cleanup
  (proposes delete_memory for entries >120 days old, de-duped against pending proposals),
  and onboarding-memory — all gated through the approval queue. Added "delete_memory" as a
  new ApprovalActionType (internal-DB-only, executes on approval). Live-verified the full
  loop: memory-suggest queued a save_memory approval, approving it created the Memory row,
  memory.read surfaced it, and context-cards ranked it 3/3 relevant for a matching query.
- **Phase 7 — Scheduled automation.** Implemented cron/github-scout (runs githubScout against
  fixed GRC/security search terms, logs an AgentRun) and cron/job-scout (re-scores tracked
  roles that have notes but no fitScore yet via real fitScore/Groq calls — never invents
  postings, since Athena holds no paid job-board API key). Live-verified both: github-scout
  pulled real public repos and logged an AgentRun; job-scout correctly found zero scoreable
  candidates (no tracked roles with notes yet) and logged its run.

New tables: FinanceEntry, JobListing (migrations add_finance_entry, add_job_listing).
Build passes clean (19 routes). Dashboard now shows live Plutus/Athena/Mnemosyne panels
reading real DB + model_usage data, and CURRENT_PHASE is 7/7 — all agents built.
Owner: Osman Jalloh.

## 2026-06-06 — Phase 2 complete: Argus daily brief (Groq-routed synthesis), verified live
Built and verified end-to-end: src/lib/modelRouter.ts (callGroq against Groq's OpenAI-
compatible chat completions endpoint, model llama-3.1-8b-instant, model_usage logging per
CLAUDE.md rule 4), src/agents/argus.ts (synthesize aggregates Kairos calendar signals + Iris
inbox triage; riskFlag is a heuristic phishing/scam phrase scan, no LLM; anomalyWatch flags
conflict_spike/unread_spike/back_to_back via thresholds, no LLM; morningBrief synthesizes
via Groq, dataClass PRIVATE, and upserts into daily_briefs), /api/brief endpoint (auth-gated),
and cron/daily-brief rewritten to run morningBrief for every user via Promise.allSettled.
Live test against the real DB and a real GROQ_API_KEY confirmed: GET /api/brief returned 200
with a generated brief, a daily_briefs row persisted, and a model_usage row logged
(provider: groq, taskType: daily-brief, dataClass: PRIVATE, ~$0.000015 est. cost). No LLM call
touches risk-flagging or anomaly detection — both stay heuristic per Argus's read-only,
no-action-tools role. Build passes clean (12 routes). Owner: Osman Jalloh.

## 2026-06-06 — Phase 3 (partial, by request): Gmail read-only + Iris triage
Added gmail.readonly scope to both OAuth flows (primary sign-in in auth.ts and the
account-link flow); existing linked accounts must re-consent once. Built src/lib/gmail.ts
(cross-account metadata-only fetch via Promise.allSettled, heuristic classify, triage) and
wired Iris's tools (gmail.read, classify, triage, draft-reply) in src/agents/iris.ts.
/api/email endpoint added. draft-reply writes a pending ApprovalAction (draft_email) row —
it never touches the Gmail API. Deliberately did NOT request gmail.compose/gmail.send:
no write power until the Phase 4 approval queue exists, per CLAUDE.md rule 3. Build passes
clean (11 routes). Owner: Osman Jalloh.

## 2026-06-06 — Phase 1 (Stage 2 + 3) complete: multi-account OAuth, calendar aggregation
Built: server-side OAuth via NextAuth v5 with jwt/session callbacks persisting tokens to
GoogleAccount table; AES-256-GCM token encryption (TOKEN_ENCRYPTION_KEY); token refresh
logic; account link/disconnect endpoints; cross-account calendar aggregation (Kairos tools);
/api/calendar endpoint. Initial Prisma migration (20260606192609_init) applied. Prisma 7
config moved to prisma.config.ts. Build passes clean (10 routes). No Gmail scopes — Phase 3.
No send/delete/write — Phase 4 approval queue. Waiting for Stage 4 go-ahead.
Owner: Osman Jalloh.

## 2026-06-06 — Stage 1 confirmed: product summary, 7-agent roster, no-overlap rationale
Claude Code read HERMES_OS_MASTER_SPEC.md v3.0 in full. Confirmed: (1) one-paragraph product
summary matches spec, (2) all 7 agents and their private tools enumerated correctly,
(3) overlap is impossible because tools are assigned exclusively — each tool appears in exactly
one agent's list. No app code written. Waiting for Stage 2 go-ahead.
Owner: Osman Jalloh.

## 2026-06-05 — Hermes OS, Vercel, single-spec, 7 non-overlapping agents
Build Hermes as a Next.js app on Vercel (Turso, NextAuth v5, Prisma), built locally in
VS Code with Claude Code. One orchestrator (Hermes) + six specialists (Iris/email,
Kairos/calendar, Argus/sentinel-brief, Plutus/finance, Athena/jobs+resume, Mnemosyne/memory).
Each agent owns one domain and only its own tools. Default model provider: Groq (Lean).
HERMES_OS_MASTER_SPEC.md is the single source of truth.
