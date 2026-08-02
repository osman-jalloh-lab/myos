# Legacy Fugu API contract retirement

Starting point: `d135f06` on `consolidation/source-of-truth`.

## API inventory and removals

Inspected Command Center project, local-build, live-build, and execution-run
routes, plus the Local Builder response contract. The local-build route formerly
accepted `fuguDesignReview`, `fuguGate`, and `fuguGateOverride`; it also exposed
design/polish reviews, scores, gate values, and a design-review artifact.

Those action branches and imports are removed. The route now has an explicit
provider-neutral action allowlist; obsolete or unknown values return a controlled
400 response before worker queuing. Retained actions are prepare, generate,
rebuild/build, Codex improvement, open/start/stop preview, and QA.

## Serialization and compatibility

`serializeLocalBuildProject()` strips all deprecated design, polish, score, gate,
override, and Fugu retry-state fields before API serialization, then supplies the
shared canonical stage. The projects route no longer serializes any of those
database columns. Old rows remain readable and their status still flows through
the shared canonical lifecycle mapping; serialization is non-mutating.

Ordinary preparation no longer resets legacy columns or runs the legacy gate.
No schema, migration, health, environment, provider file, or historical record
was changed. Live-build's remaining Fugu/Sakana match is solely historical log
text neutralization.

## Remaining references and next surface

Remaining references in `local-builder.ts` are deferred provider integration,
legacy field/type compatibility, historical schema-column creation, and
provider-owned review functions. The shared lifecycle compatibility mapping and
historical trace normalizer also intentionally retain legacy parsing.

The next cleanup surface is provider implementation, initialization, and
configuration/environment removal; it is deliberately outside this API-contract
task.

## Validation

`npm run lint` completed with 0 errors and 25 warnings. `npm test` passed 45
files and 192 tests; the focused API contract test passed 3 tests. `npm run
build`, `git diff --check`, status review, and prescribed API searches are
recorded with the implementation commit. The build emitted 10 Turbopack NFT
unexpected-file warnings, all in the existing tracing category. `CLAUDE.md`
remains an unstaged pre-existing modification and `next-env.d.ts` remains
unchanged.
