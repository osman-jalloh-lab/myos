# Active Fugu/Sakana dependency map

Captured from the baseline reference search at `b42c00b`.

| Class | Active locations | Removal boundary |
| --- | --- | --- |
| Provider/service | `src/lib/fugu-design-critic.ts` | Delete provider, retry logic, thresholds, and exports |
| Local-builder flow | `src/lib/local-builder.ts` | Remove review/gate actions, project-state writes, generated-output text, and related task transitions while retaining build and QA |
| Worker phases | `scripts/hermes-local-worker.ts`, `src/lib/execution-runs.ts` | Remove Fugu phases/sources and redaction key; retain queue lifecycle |
| API | `src/app/api/command-center/local-builds/route.ts`, `src/app/api/command-center/projects/route.ts` | Remove actions and response fields |
| UI | `BuilderOffice.tsx`, `CommandCenterClient.tsx`, `live-build/route.ts` | Remove controls, office, cards, status rows, and event labels |
| Health/context | `health-center.ts`, `context-persistence.ts`, `auto-memory.ts` | Remove provider and context reporting |
| Configuration | `.env.example` | Remove provider, gate, retry, and score settings |
| Generated output | `local-builder.ts` | Remove review language from generated README and build plan |
| Schema | `prisma/schema.prisma`, `scripts/migrate-memory-system.ts` | Retain fields as deprecated compatibility data; application stops reading/writing them |
| Tests | `fugu-design-critic.test.ts`, health and worker tests | Delete provider tests and replace flow coverage with direct build/QA tests |
| Historical evidence | `.consolidation/evidence/**`, migration history | Retain unchanged |

The original feature is spread over later builder changes. It must be removed by focused application-layer edits, not by reverting historical commits or deleting legacy data columns.
