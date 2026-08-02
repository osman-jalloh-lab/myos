# Fugu provider configuration retirement

## Boundary

Fugu/Sakana is no longer registered, initialized at Builder startup, selectable through the active model-provider registry, or represented as an active health provider or executor. The direct Builder lifecycle remains `Research/context -> Build -> Automated QA -> Completed or Failed`.

## Removed active configuration

- Removed `SAKANA_API_KEY`, `FUGU_DESIGN_PASS_SCORE`, `FUGU_DESIGN_GATE_MODE`, and `FUGU_RETRY_BASE_MS` from `.env.example`.
- Removed the Sakana/Fugu provider and Fugu Critic executor from health reporting.
- Removed Sakana configuration detection from setup-memory extraction and the local-worker configuration sanitizer.
- Removed Builder runtime calls into the provider and retained only type-only compatibility parsing for historical stored fields, so application startup does not load the retained Fugu implementation.

## Compatibility and deferred removal

The legacy provider implementation in `src/lib/fugu-design-critic.ts`, its direct compatibility tests, and the deprecated `Project` database fields remain temporarily. Legacy Fugu Builder actions are no longer exposed by active API routes or retained as runtime helpers.

No historical migration or Prisma field was changed. Existing project records retain their stored Fugu fields, which are ignored by current API serializers and canonical lifecycle progression.

## Verification coverage

`fugu-provider-configuration-retirement.test.ts` verifies that current environment documentation, Builder startup imports, health registration, worker configuration handling, and setup-memory extraction do not activate Fugu/Sakana. `model-provider-registry.test.ts` verifies the active registry does not advertise either provider.

## Next migration surface

The subsequent source-removal task can delete the now-unreachable Fugu provider implementation, legacy Builder helper exports, direct provider tests, and remaining historical generated-template/prompt references after separately confirming retained database data needs.
