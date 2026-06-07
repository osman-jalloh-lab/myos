# CLAUDE.md — Hermes OS operating rules

You are the coding agent for **Hermes OS**, Osman Jalloh's personal assistant operating system, built in this repo in VS Code.

## Read this first
- `docs/HERMES_OS_MASTER_SPEC.md` is the single source of truth for what to build. Read it fully before writing code. Do not fragment it into new planning files.
- `docs/DEPLOY_TO_VERCEL.md` is the deployment runbook.
- `docs/hermes-os-console.html` is the visual reference (layout, agent floor, palette).
- `context/about-osman.md` is who this is being built for and the writing rules for any drafted text. Read it.
- This file (CLAUDE.md) is your standing operating rules for every session.
- Other coding agents: VS Code Copilot reads `.github/copilot-instructions.md`, Cursor reads `.cursor/rules/`, and `AGENTS.md` covers the rest. They all point back here, so the rules stay identical no matter which tool is active.

## Stack (pinned — do not diverge)
Next.js (App Router) · NextAuth v5 (Auth.js) · Prisma + `@prisma/adapter-libsql` · Turso (libSQL) · deployed on Vercel with Vercel Cron. Default model provider: Groq.

## The 7 agents (each owns ONE domain and ONLY its own tools)
- **Hermes** — orchestrator: model-router, approval-queue, a2a-handoff, decisions-log, skill-registry, skill-match. Holds no raw-data tools.
- **Iris** — email: gmail.read, classify, triage, draft-reply. Drafts only.
- **Kairos** — calendar/time: calendar.read, conflict-scan, time-block, prep-notes.
- **Argus** — sentinel/daily brief: synthesize, risk-flag, anomaly-watch, morning-brief. Read-only, no action tools.
- **Plutus** — finance: finance.read, budget-cap, llm-cost-monitor, debt-tracker. No money movement.
- **Athena** — jobs+resume: job-search, fit-score, skill-gap, github-scout, resume-tailor, ats-optimize, cover-letter, app-tracker. No applying without approval.
- **Mnemosyne** — memory: memory.read, memory-suggest, context-cards, stale-cleanup, onboarding-memory. Approval-based writes.

Tools are owned exclusively (this enforces no-overlap). Skills are shared reference files any agent may read.

## Non-negotiable rules
1. Server-side OAuth only. Secrets never in frontend, never printed, never committed. Encrypt tokens at rest.
2. Give each agent ONLY its listed tools.
3. No send / delete / write power until the approval queue exists. Nothing writes silently.
4. Default to Groq (Lean Mode). Log every LLM call to `model_usage`. Sensitive data (email, I-9, finance) → Groq on Vercel; local Ollama only if a tunnel is configured.
5. Migrations before new tables. Log every decision in `decisions_log`.
6. Honor Osman's writing rules in any drafted text: no em dashes; no "excited to apply" or "great fit"; no CPT; no Sierra Leone; Security+ and CySA+ near the top of resumes; job/recruiter drafts FROM osman.jalloh@g.austincc.edu, saved as drafts.
7. If stuck, STOP and write the blocker. Do not guess or invent. Do not build ahead of the current stage.

## Build stages — STOP after each, wait for Osman's approval
- **Stage 1 (Phase 0):** no app code. Confirm: one-paragraph product summary, the 7 agents + their tools, why no overlap. Add the decisions_log seed. STOP.
- **Stage 2 (Phase 1 discovery):** inspect/scaffold, report OAuth scopes, DB tables, what is needed for 3-account support, security risks, a step plan. No edits beyond scaffolding. STOP.
- **Stage 3 (Phase 1 build):** server-side OAuth, 3 Google accounts, labels, list/disconnect endpoints, cross-account calendar aggregation, token refresh. No Gmail send. Migrations added. Run build, report. STOP.
- Do NOT build Phases 2-7 until told.

## Commands
- `npm run dev` — local dev
- `npm run build` — prisma generate + next build
- `npm run db:migrate` — Prisma migrations (libSQL adapter against Turso; see deploy runbook)
