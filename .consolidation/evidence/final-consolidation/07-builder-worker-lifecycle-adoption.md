# Builder and worker lifecycle adoption

## Transition owners before this change

- `local-builder.ts`: project creation, generation, rebuild, QA, and Codex build updates.
- `hermes-local-worker.ts`: queue claim, Hermes-agent handoff, build trace phases, and QA execution.
- `builder-lifecycle.ts`: compatibility normalization introduced by Task 1.

## New progression

All `updateProjectBuildState` writes normalize through the centralized lifecycle. Generation/rebuild success writes `qa_pending`; QA writes `qa_running` and then `completed` or `failed`. The local worker no longer emits a Fugu design-gate phase and reports direct planning-to-build progression.

## Temporary compatibility

Fugu provider code, fields, APIs, UI, health reporting, and legacy database values remain outside this task. `canStartBuildWithFuguGate` is now compatibility-only and always permits canonical build/QA progression; its legacy data no longer controls it.

## Later migration surfaces

Remove the remaining provider/API/UI/health references and replace legacy presentation fields with `deriveCanonicalBuilderStage`.
