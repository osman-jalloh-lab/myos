---
name: pr-packaging
description: "Prepare reviewable pull-request diffs from mixed working trees."
version: 0.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Pull-Request, Review, Diff]
    related_skills: [github-pr-workflow]
---

# PR Packaging

Packaging is separate from branch mechanics. A PR can open cleanly and still be un-reviewable because the diff contains unrelated local artifacts, secrets, or stale tests.

## Trigger

Use this skill when:
- committing before opening a PR
- squashing or splitting a feature branch for review
- cleaning a working tree with mixed intent

## Mandatory Checks

Before committing or opening a PR:
1. Inspect full diff.
2. Include only files relevant to the PR topic.
3. Exclude:
   - unrelated code/docs changes
   - `.env*` files and secrets
   - logs, screenshots, generated artifacts
   - `node_modules`, `.next`, build outputs
   - stale tests that assert superseded behavior

## Test Hygiene

If a test asserts removed/old behavior:
- update the test to match current behavior, or
- remove the test.

Never commit a passing test that encodes a defeated invariant; it will mislead reviewers and future CI.

## PR Body Discipline

Before opening a PR, add substantive requested sections if the user asked for them:
- What was changed
- Corrected command or invocation shape
- External/runtime dependency or worker/service dependency
- Restrictions / scope / capability boundaries
- Validation that passed
- What was not fully validated
- Exact remaining blocker for E2E verification, if any
- Clear statement whether production deployment, merge to main, or secret exposure occurred

If placeholders were used initially, update the PR description after commits/tests with real results. Remove stale assertions like `safe to merge` once the user says review is premature.

## Merge Safety Gate

Do not claim a PR is safe to merge until tests/build are green, review blockers are resolved, the user explicitly approves merge, and no production deployment, secret exposure, or destructive migration is pending.

## Commit Shape

Preferred:
- One focused commit for small integrations.
- Avoid mixing refactors, cleanup, and feature work unless the user explicitly asks.

Commit message should describe the behavioral change, not just the files touched.

## Local vs Remote

When `git diff` includes unrelated modifications:
- stash, checkout, or patch to isolate the review set.
- do not push a kitchen-sink branch "for safekeeping".
