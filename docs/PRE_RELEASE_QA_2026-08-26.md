# Hermes OS pre-release QA — 2026-08-26

## Release checkpoint

- Canonical branch: `integration/hermes-os-final`
- Starting commit: `be4ac7413fa44ed68dad91717250a7206019dd29`
- Production remains unchanged on `b16a8dd745228c878c405c69a03c29c64a128ac8`.
- Release was not pushed or deployed during this audit.

## Recovery and Git cleanup

- Verified recovery bundle: `C:\Users\osman\AppData\Local\hermes\recovery\final-branch-cleanup-20260825-232725\all-local-refs.bundle`
- Worktrees were reduced from 29 to 4 using non-forced removal only.
- Local branches were reduced from 36 to 16. Branches with unique commits, dirty worktrees, or deferred experiments were retained.
- The dirty primary checkout and its user-owned `CLAUDE.md` / audit changes were not modified.

## Validation

- TypeScript: passed.
- ESLint: passed with 28 pre-existing warnings and no errors.
- Vitest: 78 files, 425 tests passed.
- Production build: passed. Three existing Turbopack dynamic-filesystem tracing warnings remain in local Builder modules.
- Authenticated desktop and mobile browser QA: passed without page-level horizontal overflow or browser-console errors.
- Production dependency audit: 0 critical, high, moderate, or low vulnerabilities. Development-only Prisma CLI advisories remain; npm's proposed fix is an incompatible Prisma downgrade and was not applied.

## Security and compatibility

- Authenticated API routes remain user-scoped; Telegram uses webhook-secret verification, owner verification, durable update idempotency, bounded Telegram-hosted audio downloads, and shared Hermes routing.
- Approval plans exclude merge, deploy, push, force-push, credential changes, and policy bypass.
- Knowledge traversal excludes `90 Private` at the source boundary; the folder was not accessed during this audit.
- Builder keeps its Docker-only generated-project execution boundary, restricted mount, dropped capabilities, non-root user, resource limits, and owned-preview lifecycle.
- Live Turso read-only inspection reconfirmed `AgentTask.projectId` maps to `project_id` and `TelegramUpdate` matches the final Prisma contract.
- `AuditLog`, `UserSkill`, and Teach Hermes tables remain absent remotely. Audit/log views degrade safely, and Teach Hermes reports storage unavailable instead of activating fake data.
- `prisma migrate deploy` remains prohibited. Fugu data, Teach Hermes migrations, and `_prisma_migrations` were untouched.

## Production and worker baseline

- `https://www.parawi.com`: HTTP 200.
- `https://www.parawi.com/api/worker/health`: HTTP 200.
- Vercel production deployment: `dpl_9F22wG96LV2FghUTmcuY4de5WyBD`, READY.
- Telegram webhook: configured at `www.parawi.com`, zero pending updates, no reported error.
- One authoritative worker process tree is running from the `Hermes Local Worker` Scheduled Task. The disabled Startup shortcut remains disabled, and no active lease/task was found.
- Worker rollback records are kept under `C:\Users\osman\AppData\Local\hermes\recovery\worker-upgrade\`.

## Remaining release gate

Run the prepared Administrator PowerShell worker verification/upgrade script, verify a single healthy worker, then repeat the fast-forward and production baselines before the separately authorized release. Manual desktop microphone and user-originated Telegram voice acceptance remain human checks.
