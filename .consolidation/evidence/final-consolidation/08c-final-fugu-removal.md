# Final Fugu/Sakana removal

## Scope and commits

- Starting commit: `4061807`
- Source removal: `75990e3` — `refactor: delete unreachable Fugu implementation`
- Schema migration: `3f48d4e` — `migration: remove deprecated Fugu schema fields`
- Documentation completion: recorded by the following commit.

## Completed removal

- Deleted `src/lib/fugu-design-critic.ts` and its direct provider test.
- Removed the remaining Builder gate compatibility functions, Fugu-era review fields, provider-specific prompts, generated README/plan text, skill ownership, and execution phase/source values.
- Removed the nine retired `Project` columns from the current Prisma schema.
- Added `20260802000000_remove_fugu_schema`, a forward SQLite/libSQL table-rebuild migration that preserves project identity, lifecycle, build, preview, research, QA, and timestamp data.
- No package dependency was removed: repository inspection found no package used exclusively by Fugu/Sakana.

## Migration validation

`fugu-schema-removal-migration.test.ts` creates a disposable legacy `Project` table with populated Fugu-era values plus modern completed and QA-pending records. It applies the migration and confirms all surviving project data remains readable while the nine retired columns are absent.

The test passed. The migration SQL also passed `prisma db execute` against a disposable SQLite database. `prisma migrate deploy` on a disposable SQLite URL could not initialize Prisma's schema engine in this workstation and returned an empty `Schema engine error` before SQL execution; retry it in CI or staging before production deployment. No production migration was applied.

## Remaining historical references

Allowed references remain only in historical migration scripts, the new schema-removal migration/test, consolidation evidence, final removal documentation, and neutral historical trace normalization. No active provider implementation, import, registry, factory, configuration, API action/field, UI presentation, worker execution path, prompt, template, or current Prisma field remains.

## Validation

- Lint: 0 errors, 24 warnings (baseline preserved).
- Tests: 46 files, 190 tests passed.
- Production build: passed.
- Prisma schema validation and generation: passed.
- Turbopack: passed with 11 existing NFT whole-project tracing warnings from dynamic filesystem use in `local-builder.ts`.
- Protected files: `CLAUDE.md` remained modified and unstaged; `next-env.d.ts` remained unchanged and unstaged.

## Deferred

Production deployment is intentionally deferred. Back up/export the target Turso/libSQL database, rerun `prisma migrate deploy` in CI or staging, then follow `docs/FUGU_SCHEMA_REMOVAL.md` for preflight, verification, and restore.
