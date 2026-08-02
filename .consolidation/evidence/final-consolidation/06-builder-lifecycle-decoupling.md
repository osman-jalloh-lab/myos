# Builder lifecycle decoupling

## Old state source

Builder state currently comes from `Project.status`, `Project.localQaStatus`, local-builder transitions, and worker execution phases. Fugu-era project values are retained for compatibility but are not canonical lifecycle values.

## Canonical stages

`queued`, `researching`, `building`, `qa_pending`, `qa_running`, `completed`, and `failed`.

## Compatibility mapping

- Pre-build Fugu design states (`waiting_for_fugu_design`, `fugu_design_complete`, `fugu_design_gate`, `Design Ready`, and `Design Revision Needed`) normalize to `building` because their existing code gates or precedes generation.
- `Fugu Unavailable` normalizes to `building`; existing advisory semantics permit the normal build path.
- `Fugu Error` normalizes to `failed`, matching its existing error state.
- Fugu polish waiting/review normalizes to `qa_pending`; polish completion normalizes to `completed`.
- Unknown legacy state values normalize to `queued` for safe, explicit handling.

## Unresolved decisions

This compatibility layer does not yet replace existing Fugu provider, worker, API, UI, schema, or health wiring. Those surfaces must migrate to this module before active Fugu removal.
