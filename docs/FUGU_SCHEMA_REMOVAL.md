# Fugu/Sakana schema removal

## Status

Fugu/Sakana has been removed from active source, runtime, configuration, worker execution, API, UI, health reporting, prompts, templates, tests, and the current Prisma schema. The forward migration is prepared and validated only against disposable local libSQL databases; no production database was migrated by this change.

## Removed `Project` columns

- `localDesignReview`
- `localPolishReview`
- `designScore`
- `fuguGateStatus`
- `fuguGateScore`
- `fuguGateReview`
- `fuguGateReviewedAt`
- `fuguGateOverrideReason`
- `fuguPolishStatus`

Only the `Project` table is affected. Project identity, ownership, status, build logs, preview state, research brief, QA status, QA checklist, and timestamps are preserved.

## Migration and validation

The forward migration is `prisma/migrations/20260802000000_remove_fugu_schema/migration.sql`. It rebuilds `Project` without the retired columns so it works on SQLite/libSQL versions that do not support a sequence of `DROP COLUMN` statements and on a pristine database where historical Prisma migrations predate the `Project` table.

The disposable migration test covers empty structure plus populated legacy, completed, and QA-pending projects:

```powershell
npm test -- --run src/lib/__tests__/fugu-schema-removal-migration.test.ts
```

The exact SQL also executed successfully through `npx prisma db execute --file prisma/migrations/20260802000000_remove_fugu_schema/migration.sql` against a disposable SQLite database. In this workspace, `npx prisma migrate deploy` on a disposable SQLite URL was blocked before migration execution by Prisma's schema engine with an empty `Schema engine error`; it must be retried in CI or staging before production deployment.

Apply only after a production backup and preflight:

```powershell
# Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for the intended staging or production database.
npx prisma migrate deploy
```

## Production preflight and restore

1. Export or back up the Turso/libSQL database and verify a restore on a separate database.
2. Confirm the deployed application release contains this source cleanup before applying the migration.
3. Check `Project` row counts and sample current lifecycle/QA records.
4. Run `npx prisma migrate deploy` once, with monitoring enabled.
5. Verify `PRAGMA table_info("Project")` no longer returns the nine removed columns and verify project row counts/statuses.

The migration is destructive only for the retired review values. It has no automatic rollback. Restore the verified database export and redeploy the prior application release if recovery is required.

## Historical provenance

Historical migration artifacts and consolidation evidence remain unchanged. They document prior behavior but are not part of active runtime or schema initialization.
