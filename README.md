# Hermes OS

Osman's self-built personal assistant operating system. Built in VS Code with Claude Code.
Deployed on Vercel. Stack: Next.js (App Router) + NextAuth v5 + Prisma + Turso (libSQL).

## Start here (VS Code)
1. Unzip this folder onto your desktop and open it in VS Code (File > Open Folder).
2. `cp .env.example .env.local` and fill in values (see docs/DEPLOY_TO_VERCEL.md).
3. `npm install`
4. Open Claude Code in VS Code. It reads CLAUDE.md automatically.
5. Paste the prompt in docs/HERMES_BUILD_KICKOFF_PROMPT.md to begin Stage 1.
6. `npm run dev` to run locally at http://localhost:3000

## What's where
- `CLAUDE.md` — operating rules the agent reads every session (repo root, do not move)
- `docs/HERMES_OS_MASTER_SPEC.md` — the single source of truth for what to build
- `docs/DEPLOY_TO_VERCEL.md` — deployment runbook (OAuth URIs, Turso, cron)
- `docs/hermes-os-console.html` — visual reference (open in a browser)
- `prisma/schema.prisma` — starter database schema
- `skills/` — the skill registry (drop your SKILL.md folders here)
- `src/agents/` — one file per agent (stubs; the agent fills these in by stages)
- `src/lib/` — db, auth, model router
- `decisions/log.md` — decision log


## Switching coding agents (Claude Code / Copilot / Cursor)
The rules live in CLAUDE.md and are mirrored by thin pointers so any agent follows them:
- Claude Code -> CLAUDE.md (auto)
- VS Code Copilot -> .github/copilot-instructions.md
- Cursor -> .cursor/rules/hermes.mdc
- Anything else -> AGENTS.md
Your portable context ("what I'm about") is context/about-osman.md, read by all of them.
If your Claude credit runs out, switch to Copilot in VS Code and keep going; the rules and
context carry over. The app's own model provider falls back automatically (Groq first).

## Important
These src/ files are scaffolding stubs with TODOs. Claude Code implements them in
stages per the spec. Stage 1 is planning only, no feature code. Do not skip stages.
