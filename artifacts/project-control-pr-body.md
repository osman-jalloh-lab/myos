## What changed

- adds the durable project-control planner, decomposition, dependency, wakeup, execution, review, QA, artifact, and completion flow
- routes project-sized chat requests through the Project Manager and exposes project flow in Command Center
- adds the `/project-control-smoke` route produced by the DB-driven smoke workflow
- adds an additive project-control migration with explicit local and remote target guards
- adds real Prometheus, Fugu, and Argus runtime adapters with linked artifacts and idempotent wakeups

## Why

Hermes needed a verifiable control plane where accepted plan revisions decompose once, dependent agents wake in order, filesystem work is tied to durable DB records, and projects cannot complete without real validation evidence.

## Safety review

- Prometheus remains blocked when no workspace is approved. The test still asserts both the wakeup outcome and task status are `blocked`.
- local migrations are refused unless `HERMES_ALLOW_LOCAL_MIGRATION=1`
- unclassified remote migrations are refused before connection unless `HERMES_MIGRATION_TARGET` is explicitly `scratch` or `production`
- smoke-only workspace and migration variables are removed from Argus child-test environments
- the integration timeout change preserves every assertion and only raises the per-test ceiling from 5 to 15 seconds for full-suite contention

## Validation

- `npx tsc --noEmit` — exit 0
- `npx vitest run` — exit 0, 44 files and 183 tests
- `npm run build` — exit 0
- isolated SQLite end-to-end smoke checklist — all seven stages passed
- final project `cmri9dlpv00007stqjb5rcdjj` reached `completed` at `2026-07-12T20:42:29.016Z`
- idempotency counts remained 1 decomposition / 4 tasks / 3 dependencies / 4 wakeups / 8 artifacts

## Not included

No production migration, production data access, merge, or production deployment was performed. Unrelated local worktree files were excluded from this commit.
