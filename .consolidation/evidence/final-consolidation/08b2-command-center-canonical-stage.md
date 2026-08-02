# Command Center overview canonical lifecycle

## Inspected scope

- `src/app/command-center/CommandCenterClient.tsx`: `OverviewPanel`, project activity feed, analytics, active-build summary, `ProjectsPanel`, and `LocalPreviewDetails`.
- Deferred: `LiveBuildConsole.tsx`, `ProjectInspector.tsx`, `RunInspectorPanel`, and the separate Agent Fugu Office.

## Lifecycle migration

The Command Center project model now requires `canonicalStage`. Overview activity, active classification, success/failure analytics, project counters, preview lifecycle labels, project-card badges, filter results, and lifecycle sorting use `builder-stage-display.ts` rather than legacy status, QA, or review fields.

The shared helper now supplies canonical colors, stage ordering, filter matching, and the queued/active/completed/failed grouping. `qa_pending` and `qa_running` are active, not completed.

## Removed and retained presentation

Removed from project cards: Fugu design-review and polish-review panels, review scores, and legacy QA lifecycle badges. Project cards retain project metadata, preview links, build errors/logs, QA checklist findings, research brief, timestamps, and task details. No Fugu-only client action existed in these migrated overview/project-card surfaces.

## Deferred references

Fugu remains in the separate Agent Fugu Office and Run Inspector within `CommandCenterClient.tsx`; those are outside this overview/project-card task. `LiveBuildConsole.tsx` and `ProjectInspector.tsx` were not modified.

## Tests and validation

- Extended focused canonical display tests for grouping, filtering, and lifecycle ordering, plus Command Center source-level assertions for canonical status use, retained preview/error/QA content, and absence of Fugu/Sakana in `ProjectsPanel`.
- `npm run lint`: passed with 0 errors and 25 existing warnings.
- `npm test`: passed, 43 files and 179 tests.
- `npm run build`: passed. It reported 11 existing Turbopack tracing warnings from `next.config.mjs` / `local-builder.ts`; no new warning category appeared.

## Next migration surface

The deferred shared live-build and Run Inspector surfaces are the next Command Center lifecycle migration candidates.
