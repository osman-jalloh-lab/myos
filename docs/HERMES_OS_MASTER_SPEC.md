# HERMES OS — MASTER SPEC (single source of truth)

> **Version:** 3.0 · **Owner:** Osman Jalloh · **Updated:** 2026-06-05
>
> **Read this:** This one file replaces the scattered `docs/`, `context/`, `references/`, and `decisions/` folders from earlier drafts. Do not fragment the plan back into many files. Hermes reads **only this spec** to build. Visual reference: `hermes-os-console.html` (the Agent Console mockup).

---

## 0. What this is

Hermes is Osman's **self-hosted personal assistant operating system**. It is a small AI operating system: one orchestrator plus six specialist agents, each owning one domain and its own private tools, with a hard approval gate on every write.

It is **not** a Cluey refactor anymore. It is a **new standalone app**, self-hosted on Osman's always-on home machine, reached from his phone, with local models doing the sensitive work.

---

## 1. Naming and surfaces

| Term | What it is |
|---|---|
| **Hermes (OS)** | The product. The whole assistant system. |
| **Hermes Web** | The self-hosted Next.js app. Primary UI: dashboard, agent floor, approval queue. |
| **Hermes Agent (Nous)** | The existing local agent on Osman's Windows box (NousResearch, PowerShell, Telegram, Claude Opus via Nous Portal). Acts as a **surface and notifier**, not a second source of truth. |

---

## 2. Deployment architecture — Vercel (the build target)

```text
Phone / laptop (client)
  ▼  https://hermes.<your-domain>   (custom domain on Vercel)
Vercel — Next.js app
  ├── UI (App Router) + API routes (serverless functions)
  ├── Vercel Cron → /api/cron/*  (daily brief, weekly scouts)
  └── Tool adapters: Google (Gmail/Calendar), Job sources, GitHub, LLMs
        ├── Turso (libSQL) — state, tokens, logs, memory
        └── Models: Groq (cheap default) · OpenAI / Claude (on demand)
              └── optional: home Ollama via Cloudflare Tunnel for true-local privacy mode
```

**Stack:** Next.js (App Router) + NextAuth v5 + Prisma + Turso (libSQL) on **Vercel** — matches Osman's Parawi stack. Operational steps live in `DEPLOY_TO_VERCEL.md`.

**The one tradeoff to know:** Vercel is serverless, so it cannot host a persistent local Ollama. Local-first becomes **Groq-first** as the cheap default (still cents/month). If Osman wants sensitive data (email, I-9, finance) to stay truly local, keep Ollama on the home box and expose it to Vercel via a Cloudflare Tunnel set as `OLLAMA_BASE_URL`. Default: Groq.

**Domain:** add the owned domain in Vercel → Project → Domains as `hermes.<your-domain>`, and set the same value as `NEXTAUTH_URL`. *(Fill this in — it is the one open value.)*

---

## 3. The office: 7 agents, zero overlap

**Pattern:** orchestrator-worker (supervisor) with A2A-style handoffs. Hermes routes and gates. Each specialist owns one domain and its own private toolset. **A skill lives in exactly one agent.** No agent reaches into another's tools.

### Roster

| Agent | Domain | Private tools (only this agent has them) | Autonomy at launch |
|---|---|---|---|
| **Hermes** | Orchestration | `model-router`, `approval-queue`, `a2a-handoff`, `decisions-log`, `skill-registry`, `skill-match` | Routes, gates, matches skills. Holds no raw-data tools. |
| **Iris** | Email | `gmail.read`, `classify`, `triage`, `draft-reply` | L2 Drafted — read + draft only |
| **Kairos** | Calendar & time | `calendar.read`, `conflict-scan`, `time-block`, `prep-notes` | L2 Drafted — suggest only |
| **Argus** | Sentinel & daily brief | `synthesize`, `risk-flag`, `anomaly-watch`, `morning-brief` | L0 Read-only watcher — no action tools |
| **Plutus** | Finance & spend | `finance.read`, `budget-cap`, `llm-cost-monitor`, `debt-tracker` | L1 Suggested — track + warn only |
| **Athena** | Career & jobs | `job-search`, `fit-score`, `skill-gap`, `github-scout`, **`resume-tailor`, `ats-optimize`, `cover-letter`, `app-tracker`** | L1/L2 — search + draft only |
| **Mnemosyne** | Memory | `memory.read`, `memory-suggest`, `context-cards`, `stale-cleanup`, **`onboarding-memory`** | L1 Suggested — approval-based writes |

### Per-agent can / can't

**Hermes (orchestrator).** Can: route tasks, pick the model (OpenAI / Claude / Groq / local), match the right skill from the registry and attach it to a run, hand off between agents, gate every write, log decisions. Can't: read raw email/finance/calendar data itself — it delegates.

**Iris (email).** Can: read, classify, triage, and draft replies across all 3 Google accounts; mark relevance with a reason. Can't: send, delete, archive, or label automatically; touch calendar or money.
High priority: ACC HR, supervisor/team, I-9/Workday, UT System OCIO, school/F-1/tuition, recruiters and GRC/cyber/HRIS roles, bills/rent/insurance/health, deadlines within 7 days. Low: promotions, repeat marketing.

**Kairos (calendar & time).** Can: aggregate events across accounts, detect conflicts, suggest time blocks, write prep notes. Can't: create or move events without approval; send email.

**Argus (sentinel & daily brief).** Can: read every other agent's output, greet Osman, build the morning "here's what's going on today" brief, flag risks and suspicious mail. Can't: hold any action tool. Pure read-only watcher — this is the security-guard role.

**Plutus (finance & spend).** Can: track UFCU spend by category, monitor the LLM budget cap, track June debt-paydown progress, warn on the cap or risky spend. Can't: move money or make any transaction.
Knows the June plan: clear ~$5,092, prioritize the UFCU Visa (~17.49%), watch the hookah trend as the biggest variable cost, take-home ~$2,140/mo.

**Athena (career & jobs).** Can: find and rank roles, explain fit and missing skills, run GitHub scout, **tailor resumes to ATS 95+, optimize keyword density, draft cover letters (hook-proof-honest-close, under 250 words), and maintain the application tracker.** Can't: apply or message recruiters without approval.
**Writing rules Athena must obey:** no em dashes; no "excited to apply" or "great fit"; no CPT mention; no Sierra Leone mention; visually highlight Security+ and CySA+ near the top; never title Osman above his actual level; keep resume to one page; recruiter/job drafts addressed FROM `osman.jalloh@g.austincc.edu` and saved as drafts for review.

**Mnemosyne (memory).** Can: suggest what to remember, surface context cards, propose stale-memory cleanup, and **retain onboarding context** — when Osman onboards anywhere new, Mnemosyne proposes a memory entry for approval. Currently holds: UT System OCIO onboarding (start May 18 2026, supervisor Sarah LaRose, colleague Caleb Perkins, ~19.5 hrs/wk), ACC HR role, schedules, and active project context. Can't: save or delete memory without Osman's approval.

### A2A handoff flow

```text
Iris, Kairos, Plutus, Athena  ──produce signals──►  Argus  ──morning brief──►  Osman
            │                                                    
            └──any proposed write──►  Hermes (approval gate)  ──►  Osman approves  ──►  action
Mnemosyne  ◄──► Hermes (supplies context, proposes memory for approval)
```

---

## 4. Data classes and model routing (local-first)

```text
PUBLIC:   job posts, GitHub repos, public docs        → cloud OK
PERSONAL: calendar titles, task names, profile facts  → approved cloud OK
PRIVATE:  email bodies, work/school, I-9/health/finance→ LOCAL (Ollama) by default
SECRET:   API keys, OAuth tokens, passwords           → never to any LLM
```

| Task | Provider |
|---|---|
| Fast classify | Ollama (local) → Groq |
| Daily brief | Ollama (local, privacy mode) |
| Sensitive (email / I-9 / finance) | **Local only — never leaves the host** |
| Long planning | OpenAI or Claude (on demand) |
| Code / long docs / refactors | Claude (on demand) |

**Rule:** PRIVATE data goes to a cloud model only after Osman explicitly approves that provider for that data class. Every LLM call is logged to `model_usage`.

> On Vercel (serverless), "local" defaults to **Groq** — there is no persistent Ollama. Route sensitive work to a home Ollama via a tunnel (`OLLAMA_BASE_URL`) only if true-local privacy is required.

---

## 5. Skill registry — use your Claude and OpenAI skills across both

**The capability:** while building anything, Hermes checks whether a matching skill already exists and invokes it — across Claude and OpenAI. This is possible. One correction to the model makes it clean: **skills are portable files, not vendor-locked.** A skill is a folder with a `SKILL.md` (name, description, instructions); Claude matches a task to a skill by its description and loads it automatically across claude.ai, Claude Code, and the API.

### How it works
- **One registry, provider-agnostic.** Hermes owns a `skills/` registry. Each skill is a `SKILL.md` folder (name, description, trigger keywords, instructions, optional scripts). This is the single home. Osman's existing Claude skills (i9-hr-specialist, humanizer, job-application-ops, docx, frontend-design, osman-context, etc.) drop in as files.
- **Skill-match step.** Before a specialist runs a task, Hermes runs `skill-match`: scan registry descriptions for a fit, attach the matched skill to the run.
- **Claude execution:** upload the same skills to the Claude API via the `/v1/skills` endpoint; Claude auto-invokes the right one by description. Requires the Code Execution Tool beta.
- **OpenAI execution:** OpenAI has no native skill-discovery, and ChatGPT Custom GPTs cannot be enumerated or called from the public API. So Hermes does the match itself, then injects the matched skill's instructions into the system prompt and registers its scripts as function-calling tools. Same registry, same skill, GPT runs it.
- **Result:** Osman says "build X." Hermes checks the one registry, finds the skill, runs it on Claude or OpenAI per the model router.

### Tools vs skills (this preserves no-overlap)
- **Tools** are owned exclusively — gmail only Iris, calendar only Kairos, money only Plutus. That exclusive ownership is what prevents overlap.
- **Skills** are shared reference capabilities, like SOPs. Athena uses resume + humanizer; Iris uses humanizer when drafting; Argus uses i9-hr-specialist for HR context. Several agents using the same skill is not overlap, the same way two people reading the same handbook isn't.
- Hermes owns the registry and the matching (`skill-registry`, `skill-match`); specialists execute matched skills inside their own domain only.

### On "connecting API history"
API keys let Hermes *call* OpenAI and Claude. They do not pull past ChatGPT/Claude conversation history — there is no live history API for that. Past chats as memory are Mnemosyne's job, via exports, separate from the skill registry.

### Security (non-negotiable)
Load only skills Osman authored or got from Anthropic. A skill can direct the model to run tools or code, so a malicious skill is a real exfiltration risk — audit every SKILL.md and script before adding it. Skills are not eligible for Zero Data Retention.

---

## 6. Cost structure (Lean Mode default)

Self-hosting means compute is already paid for. Run **Lean Mode** through the summer debt window.

| Item | Lean | Notes |
|---|---|---|
| Vercel hosting | $0 | Hobby tier. Cron is limited (~1/day, not exact-minute) — use Pro or an external scheduler (cron-job.org / GitHub Actions) for weekly/precise jobs. |
| Turso (libSQL) | $0 | free tier |
| Domain | $0 | reuse owned domain, added in Vercel |
| LLM (Groq default, cloud on demand) | $0–5/mo | Groq is pennies at personal volume |

**Controls (build these):** `model_usage` logging + a cost panel; a `MONTHLY_BUDGET_CAP` env that forces local/Groq and pings Telegram when crossed; metadata-first email fetch; Lean Mode as the default until the system proves itself.

**Realistic monthly cost: ~$0–5 in Lean Mode.**

---

## 7. Safety / approval model

- **Phase 1 — read/draft only.** Read calendar, read email metadata + selected bodies, summarize, classify, draft replies, suggest events/tasks. No send/delete/archive/label, no events without approval, no job applications, no memory writes.
- **Phase 2 — approved writes.** After the approval queue exists: Gmail drafts, click-approved events, tasks, approved labels.
- **Phase 3 — supervised automation.** After logs prove reliability: auto-label low-risk mail, auto-create obvious-deadline tasks, scheduled daily brief.
- **Never fully automate:** sending sensitive emails, immigration/legal advice, health/financial decisions, job applications, deleting user data.

---

## 8. Database (condensed)

Tables: `users`, `google_accounts` (per-account tokens, label, refresh), `agent_runs`, `daily_briefs`, `tasks`, `approval_actions` (action_type, payload, status — nothing writes silently), `model_usage` (provider, tokens, est_cost — powers the cost panel), `memory` (fact, source, approved_at), `decisions_log`. Use real migrations; log schema changes in `decisions_log`.

---

## 9. Build phases

0. **Stabilize.** Commit this master spec. No app code yet.
1. **Multi-account Google.** Server-side OAuth, 3 accounts, labels (Work/UT/Personal), list + disconnect, token refresh, account-aware calendar aggregation.
2. **Calendar daily brief.** Kairos + Argus produce a calendar-only brief; save to `daily_briefs`; approval-queue placeholder.
3. **Gmail read + triage.** Iris: metadata-first fetch, classify, draft replies (no send).
4. **Approval queue.** `approval_actions` + UI; every write needs a click; log approve/reject.
5. **Plutus + Athena.** Finance tracking + cost panel; job scout, fit-score, resume/cover-letter drafts, app tracker.
6. **Model router.** `modelRouter.ts`, data classification, per-provider privacy, `model_usage` logging, budget cap, Ollama fallback.
7. **Scheduled automation.** Morning brief + weekly scouts on cron; notify via Telegram after approval; toggleable.

---

## 10. First tasks for Hermes (do in order)

**Task A — Phase 0.** Read this spec. Confirm you can (1) state the product in one paragraph, (2) list all 7 agents with their one domain and private tools, (3) explain why no agent overlaps. Create `decisions_log` entry: "Adopt Hermes self-hosted OS, single-spec source of truth, 7 non-overlapping agents." Do not change app code.

**Task B — Phase 1 discovery.** If reusing any Cluey code, inspect the OAuth + calendar functions and report: current scopes, DB tables, what must change for reliable 3-account support, security risks, and a small step plan. Do not edit code.

**Task C — Phase 1 build.** Self-hosted Next.js + Postgres/Turso. Server-side OAuth, 3 linked accounts, labels, list/disconnect endpoints, cross-account calendar aggregation, token refresh. No Gmail send. No silent writes. Add migrations. Update `.env.example` with placeholders only. Run build and report.

---

## 11. Implementation rules

1. Do not fragment this spec back into many files. This file is the source of truth.
2. Phase 0 and 1 only to start. Read existing code before editing.
3. Server-side OAuth. Secrets never in frontend. Never print or commit secrets.
4. Encrypt tokens at rest before production.
5. Give each agent **only** its listed tools — that is what enforces no-overlap.
6. No agent gets send/delete/write power until the approval queue exists.
7. Default to Lean Mode; log every LLM call to `model_usage`.
8. Sensitive data (email, I-9, finance) stays on local models.
9. Migrations before new tables. Log decisions in `decisions_log`.
10. If stuck, stop and write the blocker clearly instead of guessing.

---

## 12. Env vars

```text
HERMES_DOMAIN=hermes.<your-domain>
NEXTAUTH_URL=https://hermes.<your-domain>
NEXTAUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
NOUS_PORTAL_API_KEY=
OLLAMA_BASE_URL=                       # optional: home Ollama via tunnel for true-local privacy
MODEL_ROUTER_DEFAULT_PROVIDER=groq
SKILL_REGISTRY_PATH=./skills
CLAUDE_CODE_EXECUTION=enabled          # required to run Claude Skills via the API
MONTHLY_BUDGET_CAP=10
CRON_SECRET=                           # protects /api/cron/* endpoints
TELEGRAM_BOT_TOKEN=
TOKEN_ENCRYPTION_KEY=
```
Set these in Vercel → Project → Settings → Environment Variables (and in `.env.local` for local dev). Never commit them.

---

## 13. Decision log seed

```markdown
## 2026-06-05 — Hermes self-hosted OS, single-spec, 7 non-overlapping agents
Decision: Build Hermes as a standalone self-hosted Next.js app on Osman's always-on home
server, reached from his phone via Tailscale, local-first with Ollama. One orchestrator
(Hermes) plus six specialists (Iris/email, Kairos/calendar, Argus/sentinel-brief,
Plutus/finance, Athena/jobs+resume, Mnemosyne/memory). Each agent owns one domain and its
own tools — no overlap. This single master spec replaces the old multi-folder docs.
Why: earlier all-at-once + scattered-files approach caused loops and fragmentation.
Owner: Osman Jalloh.
```
