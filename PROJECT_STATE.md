# Hermes OS Project State and Repository Consolidation Plan

**Status:** Active recovery document  
**Owner:** Osman Jalloh  
**Created:** 2026-08-01  
**Review cadence:** Update after every consolidation pull request

## Purpose

This file is the operational source of truth for the current Hermes OS codebase. It records repository authority, verified health, unresolved assumptions, safe consolidation work, and the next approved unit of work. It does not replace source code, tests, decision history, or subsystem runbooks.

## Authority

- **Candidate local integration baseline:** `C:\Users\osman\OneDrive\Desktop\my os\hermes-os`
- **Consolidation branch:** `consolidation/source-of-truth`
- **Canonical remote destination:** `https://github.com/osman-jalloh-lab/myos.git`, branch `main`
- **Qualification:** the local baseline and `origin/main` share history, but are not identical. On 2026-08-01, the baseline was five commits ahead of `origin/main`; its merge base was `b16a8dd`.

GitHub `main` is the destination, not proof of local completeness. Do not force-push it. No variant is to be deleted or bulk-merged.

## Source-of-truth hierarchy

1. Executable behavior: source code, migrations, tests, and successful validation commands.
2. This file: current repository authority, health, risks, and approved next work.
3. `decisions/log.md`: append-only technical decisions and reasons.
4. `docs/HERMES_OS_MASTER_SPEC.md`: product intent and target architecture, not live status.
5. Focused runbooks and `hermes-context/`: operations and personal context respectively.
6. Archived forks and reports: historical evidence only.

## Consolidation safety rules

- Freeze feature work in variant folders; use them only as read-only sources.
- Preserve user edits. `CLAUDE.md` and `next-env.d.ts` were dirty before this branch and are protected.
- Port one capability at a time with its tests, provenance, and rollback plan.
- Do not treat identical dependencies or generated files as evidence of equivalence.
- Keep exactly one active implementation per capability; resolve ambiguous competing imports.

## Verified workspace state

| Area | Status | Evidence | Next action |
| --- | --- | --- | --- |
| Canonical local repository | Candidate, controlled | `hermes-os` has 963 tracked files / 888 relevant files and is five commits ahead of `origin/main` | Consolidate through PRs only |
| Repository inventory | Complete for current workspace | `../hermes-repository-inventory.csv` contains path, remote, branch, HEAD, dirty state, and file counts | Update after each consolidation PR |
| Recovery references | Complete | Each repository has `backup/pre-consolidation-2026-08-01`; clean repositories also have a `pre-consolidation-2026-08-01` tag | Retain until two successful release cycles |
| Dirty work | Preserved | Binary patches for `hermes-os`, `hermes-os-deepseek-council`, and `paul` are in the workspace parent | Review independently; do not overwrite |
| Obsidian execution | Characterized but incomplete | The two baseline-only files exist, but tools are unregistered and `obsidian_worker` has no worker implementation | Preserve as evidence; require an approved secure reimplementation |
| DeepSeek council/direct | Fragmented | Dedicated variant branches and source/tests exist | Establish feature provenance matrix |
| Fugu/Sakana gate | Policy conflict | Canonical code still contains active Fugu/Sakana references; no variant code was imported | Plan a separate approved removal review |
| Skill upgrades | Highly divergent | The skill-upgrade variant has broad source drift | Review by subsystem, never bulk copy |
| Cron buckets | Working by design | Dynamic `src/app/api/cron/[bucket]/route.ts` serves daily/weekly/monthly buckets | No action |
| Environment docs | Verified complete for static reads | Runtime/local-worker settings documented in `.env.example`; no non-platform static reads remain undocumented | Recheck when environment reads change |
| Lint | Passing with warnings | `npm run lint` reports 0 errors and 25 warnings after the p5js ESM conversion | Triage warnings by subsystem in small commits |
| Validation | Passing | `npm test -- --run`: 41 files / 161 tests passed; `npm run build` compiled successfully | Address Turbopack tracing warnings separately |
| Master spec freshness | Stale/partial | Spec date and agent roster conflict with later implementation evidence | Reconcile after code consolidation |

## Feature provenance matrix

| Capability | Candidate source | Source commit | Key files | Tests | Decision |
| --- | --- | --- | --- | --- | --- |
| Obsidian execution | local `hermes-os` | TBD | `obsidian-worker-task.ts`, `obsidian-tools.ts` | TBD | Preserve in baseline |
| DeepSeek council | `hermes-os-deepseek-council` | `ce093db` | TBD | Variant tests | Review |
| DeepSeek direct | `hermes-os-deepseek-direct` | `611fd56` | TBD | Variant tests | Review |
| Fugu gate/retry | `hermes-os-fugu-gate` | `0ddaf0f` | TBD | Variant tests | Review |
| Skill upgrades | `hermes-os-skill-upgrade` | `b4bd6ae` | TBD | Variant tests | Extract by subsystem |
| p5js exporter | local `hermes-os` | working branch | `skills/p5js/scripts/export-frames.mjs` | lint | Preserve and validate |

## Current approved work

1. Finish the low-risk lint and environment-documentation commits without touching protected user edits.
2. Create a feature provenance record for Obsidian execution, then validate it independently.
3. Review Fugu, DeepSeek direct, DeepSeek council, and skill upgrades one capability at a time.
4. Reconcile architecture, roster, and deployment documentation only after code consolidation.

## Definition of done

Consolidation is complete only when one writable Hermes OS repository and protected remote `main` are authoritative; retained capabilities have provenance and tests; `npm run lint`, `npm test`, and `npm run build` pass; `.env.example` documents operational configuration; core documentation agrees with implemented architecture; and variants are tagged and archived, not deleted.
