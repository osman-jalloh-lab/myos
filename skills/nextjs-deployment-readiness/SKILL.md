---
name: nextjs-deployment-readiness
description: Audit and prepare a Next.js app for production deployment on Vercel or similar hosts. Use for preflight checks, build validation, dependency cleanup, environment variable verification, AI/server-side routing checks, and deployment risk reporting.
---

platforms: []
version: 0.1.0
license: MIT
# Next.js Deployment Readiness

Use when preparing a Next.js app for production deployment or auditing an existing project for Vercel/self-hosted readiness.

## Trigger

Any request to verify, stabilize, preflight, or deploy a Next.js app before production.

## Preflight Sequence

1. Inspect the project root for unrelated repos or stray directories that can poison the build.
2. Confirm package manager state with `npm install --no-audit --no-fund`.
3. Run Prisma/ORM generation first, then `next build`.
4. Confirm Next.js telemetry/version first when environment is uncertain.
5. Treat TypeScript no-emit as secondary; focus on build exit status and route compilation.

## Common Blockers
## Common Blockers
- Stray git repos nested inside the project root.
- Wrong `.env` handling: committed secrets, missing `.env.example`.
- Database config mismatch between local and Vercel (Turso/libSQL/SQLite).
- AI keys referenced from client bundles instead of server-side API routes.
- Windows OneDrive paths and MSYS pathspace resolution issues that cause tools to write files outside the intended repo root.
- Browser/bot-only integrations being tested from paths that should never run during build.
- Local migration generation failing because Prisma schema provider is set to `libsql`; temporarily switch to sqlite for the process-scoped command, then restore the original provider.
- Local `dev.db` already exists and Prisma reports schema drift/history drift; remove only `dev.db` for a fresh local migration generation, not for data reset.
- Turso CLI not available on Windows natively; install in WSL using the official script, then call WSL tools from Windows when needed.

## Required Checks
## Required Checks
- No secrets in client-side code.
- All external service calls happen through server-side API routes.
- AI/router logic has a cloud-first default; local fallback is explicitly opt-in.
- `.env` files are ignored in VCS.
- Confirm project-local client-side code excludes production integrations: do not call local Ollama, direct local assistant endpoints, or browser-only APIs from shared UI code paths that are part of `next build`.
- If a `.env` inspection is needed, use .env.example/.env docs rather than reading secret-bearing `.env` files.

## Hard Rules
- Do not print or expose secrets, API keys, tokens, passwords, or private env values.
- Do not create `.env.example` with real values; use variable names only.
- Do not commit `.env` or `.env.local`.
- Do not enable Ollama in production.
- Do not make Hermes depend on `NEXT_PUBLIC_*` env vars.
- Never silently fall back to localhost in production for OAuth or AI providers.
- Do not edit secrets-bearing files unless explicitly asked.
- Do not run `prisma db push` against a `libsql://` datasource URL.
- Use bash shell syntax for inline env assignment in migration commands on Windows; do not use `$env:` PowerShell syntax in bash/MSYS shells.

## User Preferences
- Report files changed, files unchanged, and files that failed to change explicitly.
- Provide exact environment variable names needed for Vercel.
- Provide exact Google OAuth redirect URIs needed.
- Provide exact manual setup steps for database/auth/services.
- Keep markdown docs updated to reflect Hermes-first AI integration.
- Do not redesign or refactor beyond the stated production-readiness task.
- Preserve old AI routes as fallback; do not delete them.
- Verify file paths from confirmed repo root with `pwd` / `git rev-parse --show-toplevel` before edits.
- If a path mismatch occurs, stop and report instead of proceeding.

## Report Shape
Use this order when reporting deployment readiness:
1. What passed
2. What failed
3. Exact fix needed
4. Whether safe to deploy
5. Files changed
6. Files unchanged
7. Exact Vercel environment variables
8. Exact Google redirect URIs
9. Exact manual steps for the user
10. Remaining risks

## Turso Migration Edge Cases
- If `prisma migrate dev` fails with provider not known for sqlite, temporarily switch to sqlite, backup first, restore after.
- If Prisma reports drift/reset due to existing local `dev.db`, remove `dev.db` and rerun migration generation.
- If Turso shell fails with `SQLITE_UNKNOWN`, the likely cause is missing auth token in the database URL or no matching tables.

## Verification Order
1. `git status --short`
2. `git diff --stat`
3. Targeted `git diff -- <files>` for changed sources
4. `npm run lint`
5. `npm run build`
6. Confirm Hermes/Ollama/OAuth behavior from source after patches
7. Read back changed files to confirm edits landed correctly

## Path and Environment Notes
- Windows + OneDrive project paths may require quoted shell paths.
- Use MSYS/POSIX shell syntax (`ls`, `cd 'C:\path'`, `&&`, `|`) rather than PowerShell builtins.
- Treat OneDrive path resolution as a likely failure point; verify `pwd` after directory changes.

## Deliverable

Give the report in this order:
1. What you found
2. What was broken
3. What you fixed
4. What still needs user action
5. Exact environment variables required
6. Exact commands to run next
7. Risks before deploying
8. Path/Build Notes
