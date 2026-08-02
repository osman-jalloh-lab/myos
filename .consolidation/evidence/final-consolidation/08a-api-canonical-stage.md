# API canonical Builder stage

## Inspected response surfaces

- `src/app/api/command-center/local-builds/route.ts`: individual local-build action and queued-worker responses, through `projectView`.
- `src/app/api/command-center/projects/route.ts`: Builder Office and Command Center project-list responses.
- `src/app/api/command-center/live-build/route.ts`: live Builder progress and worker-status response, including the intake placeholder.

`src/lib/local-builder.ts` provides the local-build project shape. `src/lib/live-build-console.ts` provides the client-facing live-progress shape.

## Contract and retained compatibility

`src/lib/builder-lifecycle.ts` now exposes `withCanonicalBuilderStage`. All three serializers use that single helper, which derives `canonicalStage` from the shared lifecycle normalization without writing to the database. The returned field is one of `queued`, `researching`, `building`, `qa_pending`, `qa_running`, `completed`, or `failed`.

Legacy status, QA, design-review, Fugu gate, score, and polish fields remain unchanged and present. This task does not change API actions, UI rendering, health reporting, generated output, Prisma schema, or migrations.

## Types and tests

- Added the shared `CanonicalBuilderStageResponse` API contract and `LocalBuildProjectResponse` type.
- Added `canonicalStage` to the live-progress client response type.
- Lifecycle tests cover queued, researching, building, Fugu design/gate, Fugu polish waiting, active QA, passed QA, terminal failure, and unknown-state fallback.
- A route guard verifies all three inspected API serializers use `withCanonicalBuilderStage`; the shared-helper test verifies decoration does not mutate legacy records or remove their fields.

## Validation

- `npm run lint`: passed with 0 errors and 25 existing warnings.
- `npm test`: passed, 42 files and 168 tests.
- `npm run build`: passed. It reported 14 existing Turbopack tracing warnings from `next.config.mjs` / `local-builder.ts` (down from 15 on the earlier baseline run); no new Turbopack warning category appeared.

## Next migration surface

Builder Office, Command Center, and live build displays can consume `canonicalStage` before legacy Fugu presentation fields are removed in a later task.
