# Decisions log

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
