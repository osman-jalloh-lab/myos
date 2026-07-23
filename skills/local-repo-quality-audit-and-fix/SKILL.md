---
name: local-repo-quality-audit-and-fix
description: >
  Audit build-quality state in a local repo and fix the first real blocker
  without broad rewrites. Use when the user asks to “verify,” “fix,” or
  “stop falling through,” after a build or test failure, or when local
  validation returns inconsistent or incomplete results.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags:
      - quality
      - build
      - windows
      - onedrive
      - repo-repair
    related_skills:
      - nextjs-windows-repo-workflow
      - systematic-debugging
---

platforms: []
# Local Repo Quality Audit and Fix

## Overview

Some Windows repos look healthy from partial reads and green tests outside
the target file, but a single hidden mismatch can keep a skill or build
block from being green end-to-end. This skill is a conservative repair
pattern: inspect, narrow the required change to the smallest fix amount,
then recheck the targeted path instead of running every test everywhere.

## When to Use

- The user asks for a review, audit, or fix after a validation failure.
- You need to keep changes local and avoid unrelated churn.
- A Windows or OneDrive-backed repo interferes with ordinary write/verify.

## Do Not Use For

- Rewriting large skill bodies from scratch.
- Pushing, deploying, or editing `.env`.
- Running task-wide searches across unrelated essays or email workflows.

## Workflow

1. Narrow the failure to the smallest file/claim that is actually wrong.
2. Change only that instance. Prefer one match over blind replace_all.
3. Keep the diff inspectable in plain git output.
4. Re-run the smallest meaningful verification for just that path.
5. If the failure is buried in installed type stubs and not in local code,
   add a temporary debug test for the exact path and remove it after
   confirmation.

## Debug test pattern

Use when installed types mask failures. The test should be removable after
confirmation; do not leave debug files in `src/`.

```ts
import { describe, expect, it } from "vitest";
import { getSkill } from "@/lib/skills/registry";

describe("debug skill quality", () => {
  it("shows values for failing skill", async () => {
    const s = await getSkillById("build-orchestrator");
    console.log("qualityScore=", s.skillQualityScore, "status=", s.validationStatus);
    expect(s.skillQualityScore).toBeGreaterThanOrEqual(90);
    expect(s.validationStatus).toBe("valid");
  });
});
```

Remove after confirmation.

## Verification checklist

- [ ] Config/search sanity: missing `source` does not break registry load.
- [ ] Evaluation prompts persistent after hot reload without full process restart.
- [ ] Query result shape matches consumer expectations after schema change.
- [ ] Faster local validation: limit test scope to the exact path, not all pass/fail tests everywhere.

## Common pitfalls

- Broad language-model searches do not replace inspectable repo evidence.
- Windows backslashes and missing path separators in globs/execution cause the code to quietly skip files.
- Watching top-level vitest status does not reveal provider-level lint errors or router mismatches.
- “One change” turns into more just because testing is tedious; if a failure is explainable and does not change real caller-visible behavior, prefer an inspection record over an extra code path.
- **Dual-form skill registration:** if both `skills/<id>.json` and `skills/<id>/SKILL.md` exist for the same skill, the registry treats them as separate discovery sources and can load conflicting entries. Prefer one canonical form per skill.
- **SKILL.md frontmatter quality vs JSON-only metadata:** skill quality scoring uses richer metadata from `SKILL.md` frontmatter, including `purpose`, `strongSignals`, `negativeSignals`, `whenToUse`, `whenNotToUse`, `outputContract`, `safetyRules`, `positiveExamples`, `negativeExamples`, and `evaluationPrompts`. If a skill’s quality score is unexpectedly low, check whether it is being loaded from JSON metadata only, which may lack these fields.
- **Canonical builder skill form on Windows:** for Windows/OneDrive-backed repos, prefer folder-form skills (`skills/<id>/SKILL.md`) over root JSON files (`skills/<id>.json`) to avoid shadowing and ensure the registry parser uses the richer SKILL.md frontmatter.
- **Missing `category`/`ownerAgents`/`safetyClass`:** registry validation treats missing safety class as `missing_metadata` or `invalid`, which can block skill activation. Ensure SKILL.md frontmatter includes `category`, `ownerAgents`, and `safetyClass`.
- **Frontmatter `id` mismatch with folder name:** if the frontmatter `id` does not match the folder/file name, the skill may not resolve correctly in tests or production routing.
- **`taskTypeFor()` routing order matters:** more specific regex patterns must appear before broad fallbacks like `/build|app|site|frontend|component|feature/i`. If a test expects `project_start` but gets `general`, check whether the message was swallowed by an earlier broad pattern.
- **Evaluation prompt `expectedSkill` values use dotted IDs:** for skills with dotted IDs like `build.orchestrator`, evaluation prompts should use `expectedSkill: build-orchestrator` (kebab-case folder ID), not `expectedSkill: build.orchestrator` (dotted name).
- **Duplicate `---` block inside the SKILL.md body:** after large frontmatter rewrites, sanity-check that only the first block is YAML frontmatter and that the body starts with a heading, not another `---`. Some authoring and sync paths can accidentally insert the second delimiter inside the body, which corrupts parser output.
- **OneDrive-backed file verification requires both shells and file-tool reads:** `patch`/`write_file` may report success while the actual persisted bytes differ from what the file tool later reads. Before treating an edit as authoritative, verify with `read_file` and shell read (`sed`/`cat`) together. If they disagree, switch to `write_file` for a full-file rewrite from verified content rather than another targeted patch.
- **Repetitive identical test failures may be external state, not code:** if two identical tests disagree after same-file verification, cache or parallel state may be involved. Prefer narrowing to a unique sentinel/strace-style evidence step rather than repeating the same runner invocation.
- **Vitest type errors from installed stubs:** failures like `TS2307` for `@vitest/utils/display` or `vite/module-runner` may be pre-existing environment/module-resolution noise, not introduced by the current test edit. Treat them as noise if they unchanged before/after the edit.

## Support files

- `references/skill-registry-debug-trace.md` — registry failure patterns and hot reload nuances.
- `references/skill-registry-skill-md-pitfalls.md` — failures from thin frontmatter, missing `safetyClass`, mismatched IDs, and mixed-domain taskType routing in this repo.