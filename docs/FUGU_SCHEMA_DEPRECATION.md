# Legacy Fugu/Sakana schema deprecation

## Status

Fugu/Sakana application behavior is being removed. The deprecated fields remain stored for compatibility, but Fugu is no longer an active, configured, or selectable provider. Physical schema removal is deliberately deferred; no destructive database migration is part of this change.

## Retained compatibility fields

The `Project` model retains these historical fields:

- `fuguGateStatus`
- `fuguGateScore`
- `fuguGateReview`
- `fuguGateReviewedAt`
- `fuguGateOverrideReason`
- `fuguPolishStatus`

These fields may exist in deployed Turso/libSQL databases and old project rows. They must not control routing, build eligibility, health reporting, UI, or active API responses. Current Command Center and Builder API serializers ignore them, and ordinary prepare/build/QA API paths do not reset or write them.

## Why they remain temporarily

Dropping fields can destroy production data and needs a separately reviewed migration, backup, staging verification, rollback procedure, and a confirmed release window. Retaining unused nullable fields lets older rows load while the application no longer reads or writes the legacy subsystem state.

## Future migration prerequisites

1. Confirm no supported release still reads or writes the fields.
2. Back up affected production databases and verify restoration.
3. Inventory non-null values and decide whether export is required.
4. Test the migration against a production-shaped copy.
5. Deploy through a reversible, monitored release with a documented rollback.

## Rollback

Runtime removal can be rolled back by restoring the prior application release; legacy values remain present until the later physical schema migration. Do not run that migration automatically.
