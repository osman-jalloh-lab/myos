# Builder Office canonical lifecycle

## Inspected components

- `src/app/command-center/BuilderOffice.tsx` owns the Builder Office status badge, project summary, action controls, Fugu gate/review cards, QA card, preview panel, and progress presentation.
- `src/app/command-center/ProjectInspector.tsx` is a shared live-build display and was intentionally not changed.

## Lifecycle source

Before this migration, Builder Office rendered legacy project status, Fugu gate status, Fugu scores, and local review fields. It now requires the API-provided `canonicalStage` and uses the provider-neutral display helper in `src/lib/builder-stage-display.ts` for both labels and the `Queued → Research → Build → QA → Complete` progress track.

## Removed and preserved UI

Removed: Fugu design gate, design review, polish review, scores, provider status/error copy, review/gate/override actions, and Fugu-based build-action gating.

Preserved: direct build, rebuild, QA, preview, folder, worker availability, timestamps, build errors, build logs, and QA findings. No API actions were changed; only Fugu-only client calls were removed.

## Remaining references

There are no Fugu or Sakana references in `BuilderOffice.tsx`. Shared live-build/Command Center components and provider/API code are deferred to later tasks.

## Tests and validation

- Added focused display coverage for every canonical stage, five-step mapping, canonical-stage consumption, absence of provider text, retained preview/QA/error content, and loading/empty copy.
- `npm run lint`: passed with 0 errors and 25 existing warnings.
- `npm test`: passed, 43 files and 177 tests.
- `npm run build`: passed. It reported 12 existing Turbopack tracing warnings from `next.config.mjs` / `local-builder.ts`; no new warning category appeared.

## Next UI migration surface

Command Center overview and shared live-build displays remain the next UI surfaces for canonical lifecycle adoption.
