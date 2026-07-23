---
name: nextjs-ai-routing-migration
title: Next.js AI Routing Migration
description: Incremental migration pattern for routing AI/agent work in Next.js App Router apps, adding a new agent layer (e.g., Hermes) alongside existing routes without blind deletes or path-write errors. Covers repo-root verification, adapter shape, router updates, safe migration order, and build verification.
---

platforms: []
version: 0.1.0
license: MIT
# Next.js AI Routing Migration

Use when adding a new central AI/agent controller (Hermes, OpenAI Assistants, etc.) to an existing Next.js App Router codebase that already has AI routes (`/api/ai/chat`, `/api/ai/ceo-command`, `/api/ai/calendar-action`). Goal: integrate the new layer without blocking builds or deleting proven client/routes.

## Prerequisites

- Node.js + package manager (npm/pnpm/yarn)
- Next.js App Router routes in `src/app/api/...`
- Existing auth middleware for protected AI endpoints
- Access to repo root before any edit (do not write any path without verifying repo root)

## Step 1: Verify repo root

Always confirm repo root, then use ONLY relative paths after that.

```bash
pwd
git rev-parse --show-toplevel
```

If the paths do not match your expectations, stop. If they do, fix your mental model of root and never again assume another path is the repo root.

## Step 2: Branching strategy

Create a migration branch from current repo state. Do not mix uncommitted changes with migration work.

```bash
git checkout -b v2-<project>-<agent>
```

## Step 3: Adapter layer (server-side)

Create `src/lib/ai/<agent>.ts` with typed success/error returns.

Shape:

```ts
export async function run<Agent>Command(input): Promise<{ ok: true; data: D } | { ok: false; error: string }>
export async function run<Agent>Intent(input): Promise<{ ok: true; data: I } | { ok: false; error: string }>
export async function get<Agent>Status(): Promise<{ ok: true; data: S } | { ok: false; error: string }>
```

Rules:
- No hardcoded localhost URLs.
- Transport uses the agent's server-side routes, not client-side calls.
- Do not add client-side fallback calls to the agent.
- Keep adapters thin; push business logic into the router.

## Step 4: New agent routes

Add the server routes under `/api/<agent>/`:

- `status`: returns availability from env/config only; derive from env, do not call other services.
- `intent`: parses user intent with auth, Zod validation, structured response.
- `command`: routes commands with auth, Zod validation, single orchestrator call.

Each new route:
- Uses existing server auth from `src/lib/auth.ts`.
- Has Zod schema validation for body.
- Returns a wrapped response shape: `{ ok: true, data } | { ok: false, error }`.
- Compiles under `next build`.

## Step 5: Router update (cloud-first)

Patch `src/lib/ai/router.ts` only if the change is minimal and safe. Default to cloud-first.

Working order:

1. Map task types into three buckets: always-cloud, agent-routable (when agent enabled), local-only.
2. Always-cloud: OpenAI/Claude/Gemini for complex creative, long-form, and reasoning work.
3. Agent-routable: schedule, brief, routine note summary, status checks, triage, lookup tasks.
4. Local-only: Ollama or another local model, gated behind `OLLAMA_ENABLED=true`. Never required in production.

Behavior targets:
- If agent route is missing or disabled by env, degrade to cloud.
- If cloud fails or is disabled, degrade to local only when explicitly enabled.
- Never call local from the client; use server functions.

## Step 6: Preserve old routes

Do not delete existing AI routes during migration.

- Keep `/api/ai/chat`, `/api/ai/ceo-command`, `/api/ai/calendar-action` working.
- They can be superseded later by the new layer.
- New routes live at `/api/<agent>/...`.

## Step 7: Verify before declaring success

```bash
npm run lint
npm run build
```

If `package.json` lacks a typecheck script, do not invent one. Use lint + build as the gate.

Expected outcome:
- All new routes present in build output.
- No new lint errors introduced by the adapter/routes.
- Build succeeds with TypeScript clean.

## Step 8: Reporting
## Step 8: Repo-root verification
Repeat the Step 1 root checks before any subsequent file operation, especially after long sequences or terminal churn.

```bash
pwd
git rev-parse --show-toplevel
```

## Prisma / Turso migration workflow
Use this instead of `prisma db push` for remote libsql/Turso:
1. Keep local development on sqlite.
2. Run migration generation against local sqlite only.
3. Apply the generated SQL to Turso with its CLI.
This avoids `libsql://` push failures and reduces the risk of unintended remote schema changes.

## OneDrive / long-sequence repo-root protection

On Windows, OneDrive-spaced repo paths can drift out of sync after long terminal sequences. After extended edits, rerun:

```bash
pwd
git rev-parse --show-toplevel
```

Use `/c/Users/<user>/...` or the native Windows path consistently. If they disagree, stop path writes and re-anchor before continuing.

## Build gate vs deploy verification

`npm run build` is the typecheck/lint/build gate. `next build` may print "Build error" text and then succeed; interpret the exit code, not log wording.

If Next.js reports type errors from `scripts/*.ts` after a clean test run, clear stale state first:

```bash
rm -rf .next node_modules/.cache
npm run build
```

This avoids false failures from cached scan artifacts.

## Step 9: Reporting
Delivery should list exactly:

- files created
- files changed
- adapter API shape
- router behavior before vs after
- lint/build results
- one safest next migration step

## Pitfalls

- Blind path writes after assuming the repo root. Use step 1 every time.
- Deleting old routes before the new layer is proven in production.
- Adding client-side agent fetch to `/api/<agent>` routes. Never do this.
- Hardcoding localhost in adapters for any environment (dev, staging, prod).
- Forgetting to gate Ollama behind an env var.
- Making destructive changes to `src/lib/ai/router.ts` without isolating diff. Prefer minimal patches.

## References

See `references/migration-checklist.md` for a session-ready checklist.
