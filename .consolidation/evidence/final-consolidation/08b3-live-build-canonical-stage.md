# Live-build canonical stage migration

Starting point: `321206c` on `consolidation/source-of-truth`.

## Inspected live-build surfaces

- `src/app/api/command-center/live-build/route.ts`
- `src/lib/live-build-console.ts`
- `src/app/command-center/LiveBuildConsole.tsx`
- `src/app/command-center/ProjectInspector.tsx`
- `src/lib/__tests__/live-build-console.test.ts`

## Status and polling boundary

The route now derives the API response's authoritative `canonicalStage` from the
shared lifecycle module and uses it for active/terminal selection, the five-step
timeline, failed-state diagnostics, and retry availability. The console and
Project Inspector use the API stage for their primary label and stop polling only
for `completed` and `failed`. Queued, research, build, and both QA states remain
active. The console preserves a terminal stage against duplicate or late updates.

The displayed sequence is `Queued`, `Research`, `Build`, `QA`, `Complete`.
`qa_pending` is displayed as `Preparing QA`; `qa_running` as `Running QA`.
Failure is a general failed state unless provider-neutral diagnostics identify a
specific failed step.

## Removed presentation and retained information

The live-build timeline no longer includes intake, review, gate, Fugu, or other
provider-specific lifecycle steps. Fugu/Sakana words in legacy persisted build
logs are neutralized before presentation. No Fugu retry, override, approval, or
review action is exposed by these live-build components.

Build logs, QA logs, diagnostic errors, changed files, preview links, worker
connectivity, elapsed time, View logs, Open folder, Open preview, and the
provider-neutral retry of a failed execution task remain available.

## Deferred references

Agent Fugu Office and Run Inspector were not edited. Any remaining Fugu/Sakana
references in those surfaces are outside this task. Health reporting, provider
implementation, schema/migrations, generated templates, and shared legacy API
fields were also left unchanged.

## Validation

`npm run lint` completed with 0 errors and 25 warnings (unchanged). `npm test`
passed 43 files and 185 tests; the focused live-build helper test passed 10
tests. `npm run build` passed. The build emitted 9 existing Turbopack NFT
unexpected-file warnings, all in the `next.config.mjs` / `local-builder.ts`
trace category. `git diff --check` passed.

The scoped legacy-reference search found only the intentional log-word
neutralization in the live-build route, plus deferred Agent Fugu Office and Run
Inspector references in `CommandCenterClient.tsx`. The canonical-stage search
confirmed the route, shared live-build helper, console, and inspector consume
`canonicalStage`. `CLAUDE.md` remained a pre-existing unstaged modification;
`next-env.d.ts` was unchanged and unstaged.
