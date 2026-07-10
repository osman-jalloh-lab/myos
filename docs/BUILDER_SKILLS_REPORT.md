# Builder Skills Report

Date: 2026-07-10

## Summary

Hermes already had build-capable execution tools, but it did not have a complete skill layer for recognizing builder intent, separating diagnostics from implementation, or preferring narrow builder skills over broad helper skills. This upgrade adds the missing Builder Skill System metadata and routing coverage without adding a new autonomous execution path.

## Existing Build Capacity

Existing build-related tools and routes found during inspection:

- `src/lib/hermes-execution/tools/build-tools.ts`
  - `internal.repo.inspect`
  - `internal.code.buildFeature`
  - `internal.code.buildAndPush`
  - `internal.code.commandRun`
  - `internal.code.gitDiff`
  - `internal.code.commitOrPR`
  - `internal.deploy.status`
- `src/lib/hermes-execution/tools/internal-tools.ts`
  - Registers the core execution tools and delegates build-specific tool registration through `registerBuildTools`.
- `src/lib/hermes-execution/planner.ts`
  - Plans build, validation, command-run, deployment-status, and PR/commit workflows.
- `src/app/api/chat/route.ts`
  - Can hand execution-like chat messages into the execution layer.
- `src/app/api/command-center/local-builds/route.ts`
  - Supports local build queue/project actions.
- `src/app/api/command-center/live-build/route.ts`
  - Exposes live build console status and retry behavior.

Before this builder skill upgrade, Hermes had the mechanical ability to inspect, build, validate, diff, commit/PR, and check deployment state, but routing could still classify build-like prompts as `general` or let broad skills compete too strongly.

## Added Builder Skills

The upgrade adds five builder skills:

- `build-orchestrator`
  - Primary skill for implementation, bug fix, UI/API changes, commit/push/deploy-prep, and broad build requests.
- `project-starter`
  - Primary skill for new-project/bootstrap/MVP/architecture requests.
- `local-worker-status`
  - Read-only diagnostic skill for local worker, queue, heartbeat, Ollama/runtime, and local execution-loop health.
- `repo-change-planner`
  - Primary skill for plan-first code change requests, target files, rollback, and validation planning.
- `build-validation-runner`
  - Primary skill for typecheck, lint, test, build, Prisma generation, deployment readiness, and deployment-status checks.

Each builder skill now has a root JSON descriptor with high-quality metadata: purpose, use/non-use guidance, strong/weak/negative signals, required context, missing-context questions, output contract, safety rules, approval requirements, examples, and evaluation prompts. The paired `SKILL.md` files keep human-readable instructions only.

## Routing Changes

New or upgraded task types:

- `build`
- `project_start`
- `repo_change`
- `local_worker_diagnostics`
- `build_validation`
- `deployment_status`

Routing now prefers the builder-specific primary skill for those task types:

- `build` -> `build-orchestrator`
- `project_start` -> `project-starter`
- `repo_change` -> `repo-change-planner`
- `local_worker_diagnostics` -> `local-worker-status`
- `build_validation` -> `build-validation-runner`
- `deployment_status` -> `build-validation-runner`

Domain boundaries were preserved:

- HR/I-9 questions still route to `i9-hr-compliance-specialist`.
- Student authorization questions still route to `student-work-authorization-guard`.
- GRC/job scoring still routes to `grc-risk-role-screener` with job/context support.
- Email and tone rewrites still route to `writing-humanizer`.
- IT support ticket notes still route to `it-help-desk-trainer`.

Mixed requests such as `Fix the I-9 dashboard UI.` route to `build-orchestrator` as primary while preserving `i9-hr-compliance-specialist` as supporting context.

## Current Reach Limitation

The builder skills in this slice are guidance-layer skills. In the main chat route, `src/app/api/chat/route.ts` still checks `shouldUseExecutionLayer` before skill routing for action-like messages such as build, run, deploy, and create requests. That means a main-thread request like `build the /pricing page` can enter the execution layer before `build-orchestrator` is resolved as the primary skill.

Current reachable paths:

- per-agent chat where `targetAgent` skips the main-thread execution pre-filter
- Skills Control/API test-match flows
- any phrasing that does not trip the execution pre-filter

No route-order hack was added in this B0 slice. The proper fix belongs to B2: resolve skills first, then bridge executable skills into execution plans when the primary skill is executable and above confidence threshold. B2 is not accepted until a main-thread `build the /pricing page` message shows `build-orchestrator` as the resolved primary skill on its `ExecutionRun`.

## Safety Model

This change does not add a new write bypass. Builder skills are routing and instruction metadata layered on top of existing execution paths.

Safety constraints:

- No builder skill touches `.env` or `.env.local`.
- File edits, branch creation, commits, pushes, deploys, worker state changes, queue retries, and migration/config edits remain approval-gated.
- `local-worker-status` is read-only and no longer claims Vercel/deployment status as a local-worker diagnostic.
- Deployment status/readiness routes through `build-validation-runner`.
- Build-like no-match cases now return a specific diagnostic explanation: a build-like request was detected but no builder skill matched.

## UI Readiness

The existing Skills UI can display the builder metadata because the registry exposes:

- quality score and quality band
- validation status and warnings
- owner agents
- safety class
- trigger/evaluation examples
- instruction preview
- usage count and last used
- match confidence, matched signals, rejected skills, and warnings from test-match behavior

The JSON descriptors provide the metadata shown by the Skills UI, while each `SKILL.md` body remains available as the instruction preview.

## Validation

Full validation was run after the final routing changes:

- `npx prisma generate` - passed.
- `npx tsc --noEmit` - passed.
- `npm run lint` - passed with 18 existing unused-variable warnings and 0 errors.
- `npm run test` - passed, 31 test files, 112 tests.
- `npm run build` - passed.

Build notes:

- `npm run build` runs `prisma generate && next build`.
- Next/Turbopack still reports 1 existing NFT tracing warning related to `next.config.mjs`, `src/lib/local-builder.ts`, and `/api/command-center/local-builds`. This is a warning, not a build failure.

Focused builder/skills tests:

- `npm run test -- src/lib/__tests__/builder-skills-routing.test.ts`
- Result: passed, 1 test file, 2 tests.
- Broader skill-focused run also passed: `npm run test -- src/lib/__tests__/builder-skills-routing.test.ts src/lib/__tests__/skills-routing-v2.test.ts src/lib/__tests__/skills-quality.test.ts`, 3 test files, 10 tests.

Builder skill quality:

- `build-orchestrator`: 100, Excellent, valid, approval_required.
- `project-starter`: 100, Excellent, valid, approval_required.
- `local-worker-status`: 100, Excellent, valid, read_only.
- `repo-change-planner`: 100, Excellent, valid, approval_required.
- `build-validation-runner`: 100, Excellent, valid, approval_required.

Routing smoke results:

- `Build Provider Setup Center.` -> `build`, primary `build-orchestrator`, confidence 100.
- `Start a new pharmacy marketplace project.` -> `project_start`, primary `project-starter`, confidence 100.
- `My local agent is not functioning.` -> `local_worker_diagnostics`, primary `local-worker-status`, confidence 100.
- `Plan the files needed to add Model Council v1.` -> `repo_change`, primary `repo-change-planner`, supporting `build-orchestrator`, confidence 100.
- `Run typecheck, lint, tests, and build.` -> `build_validation`, primary `build-validation-runner`, supporting `build-orchestrator`, confidence 100.
- `Check Vercel deployment.` -> `deployment_status`, primary `build-validation-runner`, supporting `build-orchestrator`, confidence 100.
- `Fix the I-9 dashboard UI.` -> `build`, primary `build-orchestrator`, supporting `i9-hr-compliance-specialist`, confidence 100.
- `Fix I-9 email wording.` -> `communications`, primary `i9-hr-compliance-specialist`, supporting `writing-humanizer`, confidence 100.
- `Create a task to follow up tomorrow.` -> `general`, no builder match, confidence 23.
- `Wire up the local worker.` -> `build`, primary `build-orchestrator`, supporting `local-worker-status`, confidence 100.

## Commit Readiness

Expected commit scope for the Builder Skill System:

- `skills/build-orchestrator/SKILL.md`
- `skills/build-orchestrator.json`
- `skills/project-starter/SKILL.md`
- `skills/project-starter.json`
- `skills/local-worker-status/SKILL.md`
- `skills/local-worker-status.json`
- `skills/repo-change-planner/SKILL.md`
- `skills/repo-change-planner.json`
- `skills/build-validation-runner/SKILL.md`
- `skills/build-validation-runner.json`
- `src/lib/skills/scoring.ts`
- `src/lib/skills/routing.ts`
- `src/lib/__tests__/builder-skills-routing.test.ts`
- `docs/BUILDER_SKILLS_REPORT.md`

Do not include unrelated local artifacts, logs, temporary scripts, environment files, unrelated UI/font changes, or `SKILL.md.bak-20260710` backup files in a builder-skills commit.
