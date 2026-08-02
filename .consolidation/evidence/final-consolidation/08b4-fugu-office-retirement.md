# Agent Fugu Office retirement and Run Inspector neutralization

Starting point: `35444ae` on `consolidation/source-of-truth`.

## Removed Command Center UI

`CommandCenterClient.tsx` previously exposed the `fugu` Agent Office key through
the Agent Deck, office selector, and a dedicated review/scores/recommendations
panel. Those entries, view state, project review fields, and all of that panel's
display logic were removed. No client-side Fugu review, approval, retry,
override, gate-continuation, or provider-retest action remains.

## Neutral Run Inspector

The runs API now supplies `canonicalStage` by using the shared Builder lifecycle
normalizer. Run Inspector uses that API value as its primary lifecycle badge and
for terminal cancellation availability. It retains executor, run/task/project
IDs, elapsed time, progress/heartbeat timestamps, worker, folder, completion,
errors, cancellation state, fallback history, provider-neutral retry, trace
events, and safe details.

The Fugu status card and phase/status presentation were removed. Historical
trace rows that contain retired review identifiers are displayed as `Legacy
review event` from `Historical record`; their payload is not mutated and they do
not affect the run's canonical stage. Provider-neutral events remain unchanged.

## Compatibility and remaining references

`?office=fugu` and any other obsolete saved office value now safely falls back to
the Hermes Office. The active office union contains only Hermes, Athena, Builder,
and Iris.

Fugu references remain only in backend/provider compatibility, historical
mapping, and the display-normalization helper/test needed to recognize old
records. Builder, worker progression, health reporting, Prisma/schema/migrations,
generated templates, and backend Fugu provider/API fields were not changed.

## Validation

`npm run lint` completed with 0 errors and 25 warnings. `npm test` passed 44
files and 189 tests; the focused inspector-display tests passed 4 tests.
`npm run build` passed and produced 16 existing Turbopack NFT unexpected-file
warnings, all in the existing `next.config.mjs` / `local-builder.ts` trace
category. `git diff --check` and the prescribed Command Center UI searches are
recorded with the implementation commit. `CLAUDE.md` remains an unstaged
pre-existing modification; `next-env.d.ts` remains unchanged and unstaged.

## Next cleanup surface

Backend provider wiring and shared legacy Fugu fields remain the next cleanup
surface; they are intentionally outside this UI retirement task.
