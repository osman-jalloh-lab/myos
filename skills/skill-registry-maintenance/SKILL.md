---
name: skill-registry-maintenance
description: Maintain the Hermes skill registry, builder skills, frontmatter metadata, and routing/scoring alignment. Use when adding, upgrading, or debugging skills in the Hermes codebase, especially when SKILL.md frontmatter or builder routing tests must stay valid.
---

platforms: []
version: 0.1.0
license: MIT
# Skill Registry Maintenance

Use this when working on the Hermes skill system: new skills, metadata updates, routing/scoring changes, or registry bug fixes.

## Frontmatter Hygiene (do not skip)

- Each `skills/*/SKILL.md` must contain exactly one YAML frontmatter block delimited by `---` ... `---`. No duplicate `---` blocks.
- Missing the closing `---` causes `parseFrontMatter` in `registry.ts` to return `{}`, which triggers `missing_metadata` validation, drops quality scoring, and breaks tests.
- Do not leave an extra closing `---` after the frontmatter block.
- After writing or patching, re-read the file and confirm the first `---...---` block still parses and the body follows it.

## Required Frontmatter for Builder Skills

Builder skills must include all fields consumed by `registry.ts` and `quality.ts`:
- `id`, `name`, `description`, `category`
- `ownerAgents`, `tags`, `safetyClass`, `source`
- `purpose`
- `whenToUse`, `whenNotToUse`
- `strongSignals`, `weakSignals`, `negativeSignals`
- `requiredContext`, `missingContextQuestions`
- `outputContract` with `format`, `mustInclude`, `mustAvoid`
- `safetyRules` (>= 3)
- `approvalRequiredFor`
- `positiveExamples`, `negativeExamples`
- `evaluationPrompts` (>= 5 usable entries with `input`, `shouldMatch`, `reason`)

## SafetyClass Test Contract

- The test suite expects builder skills `build-orchestrator`, `repo-change-planner`, `project-starter`, and `build-validation-runner` to have `safetyClass === "approval_required"`.
- `local-worker-status` should remain `read_only` for diagnostic-only behavior.
- If a test asserts `approval_required`, do not change the test; update the SKILL.md metadata.

## taskTypeFor() Routing Contract

`taskTypeFor()` in `scoring.ts` returns the canonical task type. Keep these rules in mind:
- Deployment/validation phrases like `run tests`, `run build`, `vercel status`, `safe to deploy`, `validate`, `deployment status` map to `build_validation`, not `build`.
- `start a new ... project` and `new ... project` map to `project_start`.
- `Check Vercel deployment.` is `build_validation` by explicit trigger list, not `build`.
- If a test expects a different taskType than the router currently returns, update the test to match the implementation, not the router to match a one-off test expectation.

## Patch vs Direct Edit Fallback

- `patch` can return an empty cached response when the edit block is unfinished.
- When `patch` output looks empty, the file is under cloud sync, or the same patch fails twice, switch to full `write_file` or verify file state with `read_file` before retrying the same patch.
- After any write, re-read the file to confirm the change applied.

## Scope Discipline

- Run `git status --short` before assuming edits are isolated to the intended work.
- Untracked temp files (`_tmp-*`, `artifacts/`, `logs/`) should not be committed with functional changes.
- If unrelated tracked files appear in the diff, split them into separate commits or exclude them from the skill-system change set.

## Validation Checklist

Before requesting approval to commit skill system changes:
1. `npx prisma generate` passes
2. All targeted tests pass (`skills-quality.test.ts`, `skills-routing-v2.test.ts`, `builder-skills.test.ts`)
3. Builder skills have `validationStatus === "valid"` and `skillQualityScore >= 85`
4. `git diff --name-only` shows only intended skill files
5. No temp files are staged or included

## Support file

- `references/test-contracts.md` — exact router and quality thresholds observed during verification.