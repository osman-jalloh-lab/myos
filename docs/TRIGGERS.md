# TRIGGERS.md — How to Talk to Hermes OS

This is your command vocabulary. Say one of these, Hermes routes it to the right specialist, the specialist does the work using its own tools. You do not have to name the agent. Hermes picks based on the words you use. But you can also call an agent by name to force it ("Iris, ...").

## How delegation works

```
You say something
      |
   HERMES  (reads the keywords, picks the agent + task, picks the model)
      |
   the right SPECIALIST runs it (Iris / Kairos / Argus / Plutus / Athena / Mnemosyne)
      |
   result comes back to you (drafts queued for review, never auto-sent)
```

Hermes routes and assembles. He does not write your email or reconcile your budget himself. That is the whole point: real delegation, not one agent doing everything.

**Tool availability key:** connected (you already have it) · your own infra (Hermes OS) · needs setup

---

## IRIS — communication

| Say this | Iris does | Tools / APIs | Task |
|---|---|---|---|
| "check my email", "triage my inbox", "what's in my inbox" | Sorts inbox into needs-reply / FYI / recruiter / compliance / noise | Gmail | `iris.triage_email` |
| "reply to [person/thread]", "respond to..." | Drafts a reply, queues it for review | Gmail | `iris.draft_replies` |
| "email [person] about...", "write an email to..." | Composes a new draft FROM osman.jalloh@g.austincc.edu | Gmail | `iris.draft_replies` |
| "follow up with [recruiter]" | Drafts a follow-up, loops Athena for wording | Gmail | `iris.recruiter_followups` |
| "draft the I-9 reverification notice for [name]" | Builds the notice on the supervisor template | Gmail | `iris.recruiter_followups` |
| "send to telegram", "ping me" | Relays a message over Telegram | Telegram Bot | `iris.clear_telegram` |

Direct call: **"Iris, ..."**

---

## KAIROS — time

| Say this | Kairos does | Tools / APIs | Task |
|---|---|---|---|
| "what's my day", "my schedule", "what's today" | Pulls today plus any deadline inside 7 days | Google Calendar | `kairos.today_schedule` |
| "schedule...", "book...", "add to calendar...", "set a meeting" | Creates the event, adds a join link | Google Calendar | `kairos.schedule_event` |
| "what's coming up", "week ahead", "this week" | Week view, Monday to Sunday | Google Calendar | `kairos.week_ahead` |
| "this month", "month ahead" | Month view, flags housing + I-9 dates | Google Calendar | `kairos.month_ahead` |
| "what's due", "deadlines" | Lists hard deadlines by lead time | Google Calendar | `kairos.today_schedule` |

Direct call: **"Kairos, ..."**

---

## ARGUS — security and monitoring

| Say this | Argus does | Tools / APIs | Task |
|---|---|---|---|
| "are my sites up", "check deployments", "is parawi up", "uptime" | Confirms every production deploy is live | Vercel, Netlify | `argus.deploy_health` |
| "security check", "scan", "audit dependencies", "any vulns" | Dependency audit, reports high/critical with the fix | GitHub, npm audit | `argus.dependency_audit` |
| "any advisories", "security news" | Surfaces only advisories that touch your stack | web | `argus.advisories_scan` |
| "check for exposed secrets" | Scans repos and deploy logs for leaked env values | GitHub | `argus.secret_check` |
| "investigate [the outage / failed deploy]" | Digs into a specific incident | Vercel | `argus.investigate` |
| "is this link/email safe" | Reputation check | Malwarebytes | `argus.investigate` |

Direct call: **"Argus, ..."**

---

## PLUTUS — finance

| Say this | Plutus does | Tools / APIs | Task |
|---|---|---|---|
| "money check-in", "run my finances" (with statements attached) | Full read: total owed, in/out, by category, progress vs the ~$5,092 plan, one lever | statement parse, QuickBooks | `plutus.money_checkin` |
| "how much do I owe", "my balances", "my debt" | Current balances vs last month | statement parse | `plutus.balance_burn` |
| "am I on track" | Progress against the fall payoff plan | internal | `plutus.balance_burn` |
| "what did I spend on...", "categorize this" | Categorizes flagged transactions | internal | `plutus.categorize_txn` |
| "I got paid", "allocate my paycheck", "payday" | Proposes allocation: card first, then essentials, then buffer | internal | `plutus.payday_allocation` |

Note: UFCU has no public API, so Plutus works from uploaded statements (CSV/PDF). Direct call: **"Plutus, ..."**

---

## ATHENA — writing and career

| Say this | Athena does | Tools / APIs | Task |
|---|---|---|---|
| "tailor my resume to [job]", "resume for [role]" | Tailors and ATS-scores, will not deliver below 95 | job-application-ops skill | `athena.tailor_resume` |
| "write a cover letter for [job]" | Hook-proof-honest-close, under 250 words | job-application-ops, humanizer | `athena.draft_cover_letter` |
| "find jobs", "search [role] jobs in [place]" | Pulls matching openings | Indeed, ZipRecruiter | `athena.find_jobs` |
| "review my applications", "tracker" | Flags what needs a follow-up, hands wording to Iris | internal | `athena.review_tracker` |
| "why did I get rejected", "analyze this rejection" | Finds the fixable pattern | internal | `athena.analyze_rejection` |

Direct call: **"Athena, ..."**

---

## MNEMOSYNE — memory

| Say this | Mnemosyne does | Tools / APIs | Task |
|---|---|---|---|
| "what did we decide about...", "recall...", "remember when..." | Retrieves the logged decision and its reasoning | Turso/Prisma | `mnemosyne.retrieve` |
| "remember that...", "log this", "note that..." | Captures a decision with its context | Turso/Prisma | `mnemosyne.capture_decision` |
| "what's the status of [project]" | Returns current project state | Turso/Prisma | `mnemosyne.retrieve` |
| "summarize this week", "weekly recap" | One-page week summary | internal | `mnemosyne.weekly_summary` |
| "update my context", "my [balance/role/deadline] changed" | Updates _shared/OSMAN.md | internal | `mnemosyne.reconcile_context` |

Direct call: **"Mnemosyne, ..."**

---

## HERMES — the router (you rarely call him on purpose)

| Say this | Hermes does | Task |
|---|---|---|
| "brief me", "morning brief", "what's my day looking like" | Assembles the morning brief from all agents | `hermes.morning_brief` |
| "status", "what's running", "system status" | One-line health of the whole system | `hermes.eod_status` |
| "what should I focus on", "top priority this week" | Surfaces the one decision that matters most | `hermes.top_decision` |
| anything ambiguous | Decides which agent should own it | `hermes.route_request` |

Direct call: **"Hermes, ..."**

---

## Model routing — "go local" vs "go to the cloud / ChatGPT"

By default Hermes picks the cheapest model that can do the job: local for routine work, cloud for hard work. You can override with a phrase anywhere in your request:

| Say this | Forces | Backend |
|---|---|---|
| "use local", "run it locally", "use Ollama" | Local, free | Ollama |
| "use the cloud", "use the big model" | Best available cloud model | Anthropic / OpenAI |
| "use Claude" | Anthropic | Anthropic API |
| "use ChatGPT", "use GPT" | OpenAI | OpenAI API |

Routing rule of thumb: triage, categorizing, summaries, retrieval stay local. Resume tailoring, cover letters, security analysis, anything you will send to a human goes cloud.

---

## The gap: building things

None of the seven agents builds software. They run your life and ops. So "build me X" or "try this" has nowhere to route today. Two ways to close it:

1. **Route build requests to Claude Code** (recommended now). Keyword "build...", "scaffold...", "fix this bug", "write the component" — you, in Claude Code, not an agent. Fast, no new infra.
2. **Add an eighth agent: Hephaestus** (the forge, god of craft). Owns scaffolding, code generation, and deploys with Argus. Worth it only if you want building to run unattended on a schedule like the others.

---

## Quick reference: who owns what

| If it is about... | Agent |
|---|---|
| Email, messages, drafts | Iris |
| Calendar, deadlines, scheduling | Kairos |
| Sites, deploys, security, vulns | Argus |
| Money, debt, spending | Plutus |
| Resumes, cover letters, jobs | Athena |
| Memory, decisions, "what did we decide" | Mnemosyne |
| The daily brief, "what matters" | Hermes |
| Building software | Claude Code (or add Hephaestus) |
