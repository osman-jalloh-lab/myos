# Hermes Head Orchestration Contract Evidence

Starting branch: `consolidation/source-of-truth` at `63faeef`.

Phase 1 adds only provider-neutral contracts, an executor policy registry, skill/context boundaries, and a structured plan validator. It does not connect a provider, Telegram, task execution, Obsidian, Prisma, or a model API.

The contract intentionally references existing My OS systems rather than replacing them: `src/lib/skills/registry.ts` remains the skill authority, while approvals and execution queues remain unchanged. Validation is covered by `src/lib/__tests__/orchestration-policy.test.ts` and rejects unsafe or unbounded proposals with structured reason codes.
