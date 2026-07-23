---
name: hermes-local-worker
title: Hermes Local Worker Integration
description: Integrate the installed Hermes CLI as a local runtime adapter with strict browser QA, execution policies, and artifact management. Use when wiring Hermes Nous into a local Windows build pipeline, enforcing local-preview browser restrictions, or debugging non-executing builds caused by invalid Hermes flags or missing worker routes.
---

platforms: []
version: 0.1.0
license: MIT
# Hermes Local Worker Integration

## Trigger

Load this skill when:
- Integrating the installed Hermes CLI as a local worker/runtime adapter
- Configuring execution policy for local app builds (default tools, browser/vision gating)
- Debugging non-executing Hermes builds caused by wrong CLI flags or missing worker invocation
- Enforcing strict local-preview browser QA with screenshot artifacts
- Routing executor actions (`Prepare` → `local_worker`, `Generate` → `local_worker` or `hermes_agent`)

## Prerequisites

- Hermes CLI installed and authenticated.
  - Typical Windows path: `C:\Users\<user>\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe`
  - Verify with `hermes.exe auth list`, `hermes.exe model`, and a one-shot test: `hermes.exe chat -q "Reply with exactly: OK"`
- Playwright installed and browsers available for visual QA.
- Project has worker health endpoint and background worker process management.

## Verified CLI Invocation

Use this exact call pattern for worker tasks:

```bash
'C:\Users\<user>\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe' \
  chat -q "<prompt>" \
  --max-turns 40 \
  --source tool \
  --cli \
  -t "<comma-separated tool allowlist>"
```

- `-t` is the toolset allowlist.
- Invalid flags: `--oneshot` does not exist on current Hermes versions. Do not use it.
- PATH fallback is acceptable for portability, but the installed exe path is the verified working invocation.

## Three-Stage Execution Policy

Implement separate runtime profiles enforced in code, not only prompt text.

### Canonical Policy Module
- Source of truth: `src/lib/design-build-pipeline.ts`
- Worker path: `scripts/hermes-local-worker.ts`
- Do not hardcode per-profile tool strings outside this module.

#### Accepted Profiles
- `research`
  - Tools: `terminal,file,browser,vision,web_search`
  - Outputs: `DESIGN_RESEARCH.md`, `ASSET_PROVENANCE.json`, design brief
  - Browsing: public web only, isolated profile, no personal cookies/logins, no side effects
- `build`
  - Tools: `terminal,file`
  - Assigned project workspace only
  - No `.env.local`, credentials, Vercel/production config, DB/deployment side effects
- `local_qa`
  - Tools: `browser,vision,terminal,file`
  - Browser access restricted to assigned localhost preview URL
  - No external/public browsing or payload submission
- `visual_review`
  - Tools: `terminal,file,vision`
  - Review existing local QA screenshots only
  - Do not grant browser access for this profile
- `qa`
  - Alias for `local_qa` compatibility in code/tests
  - Prefer canonical profiles: `research`, `build`, `local_qa`, `visual_review`

#### Action → Profile Defaults
Store an explicit `executionProfile` on the queued task.
If missing, infer from action only as a last-resort fallback.
- `research | asset research | web research | inspiration` → `research`
- `generate | fix | rebuild | build | prepare` → `build`
- `browserqa | runqa | local qa | browser qa | screenshot review` → `local_qa`
- unknown → `build`

### Worker Enforcement
- Import the policy module in `scripts/hermes-local-worker.ts`
- Resolve profile from explicit task metadata before invoking Hermes
- Reject unknown/invalid profiles; fall back to `build`
- Pass only policy-approved tools via Hermes `-t`
- Record selected profile and toolset in sanitized task logs

### Local QA Browser Boundary
- Hermes CLI has no documented per-domain allowlist; do not invent one
- Use Playwright for local preview browsing and screenshots
- Local QA profile may grant Hermes browser access only if a real localhost-only allowlist exists and is enforced client-side; otherwise keep Hermes on `terminal,file,vision` for review and let the worker/Playwright own the browser step

### Policy Enforcement
- Use `validateStageTransition` before moving between stages.
- Use `validateArtifactPathing` before accepting artifacts:
  - research artifacts must end with `DESIGN_RESEARCH.md`
  - QA artifacts must include `desktopScreenshotPath` and `mobileScreenshotPath`
- `browserQaPolicy` and `researchPolicy` are the authoritative allowlist data structures; do not duplicate them in prompt text.</thinking>

## Builder Office Integration

Show explicit phase statuses, not just “completed / failed”:
- Research Complete
- Build Passed / Failed
- Browser QA Passed / Failed
- Visual QA Passed / Failed / Needs Review

Show artifacts:
- desktop screenshot
- mobile screenshot
- asset provenance file
- research brief
- preview URL
- number of repair passes used

Completion gate:
Do not mark a build complete unless:
- build passes
- browser QA passes
- screenshots exist
- visual QA passes or is explicitly marked needs review

## Default Execution Policy

- Default toolset: `terminal,file,browser,vision`
- Excluded by default: `web_search`
- Broader tools require explicit task-level approval from the user.
- Browser restrictions:
  - Only navigate to `localhost`, `127.0.0.1`, `0.0.0.0`, or `[::1]`.
  - Matches only the assigned local preview URL; do not drift to production, external sites, personal accounts, or browser profiles.
  - Do not submit external forms or create side effects outside the assigned project.

## Executor Routing

- `Prepare` action always uses `local_worker` to create the Project record before Hermes Nous can run.
- `Generate` and subsequent actions may use `local_worker` or `hermes_agent`.
- If `body.executor` is omitted, default to `local_worker`.

## Local Preview Browser QA

Required visual QA flow after every successful build:

1. Run `npm install` only if required.
2. Run `npm run build`.
3. Start the local preview.
4. Inspect viewports:
   - Desktop: `1440x900`
   - Mobile: `390x844`
5. Capture screenshots for both viewports.
6. Inspect screenshots against rubric:
   - no blank or broken sections
   - no obvious clipping or horizontal overflow
   - readable text and acceptable contrast
   - clear visual hierarchy
   - buttons look actionable
   - spacing and alignment are consistent
   - mobile layout is usable
   - design matches the original build request
7. Run interaction checks:
   - homepage loads
   - first primary action responds
   - no major console errors
   - no obvious mobile overflow
8. If visual QA finds a fixable issue, repair it and rerun visual QA.
9. Limit automatic repair to two iterations.
10. Save screenshots and QA findings as local build artifacts.
11. Display screenshots, QA result, failed checks, and preview URL in Builder Office.

### Origin Enforcement

Before any browser automation:

```ts
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
// ... create context and page ...
// Only accept localhost/127.0.0.1/0.0.0.0/[::1] origins
// Block production, external, or user-specific URLs
```

### Artifact Storage

- Store QA artifacts under the project workspace in a gitignored folder (e.g., `artifacts/qa/`).
- Screenshots must not be committed unless explicitly requested.

## Safety and Completion Gates

- Do not claim visual QA passed unless screenshots were captured and reviewed.
- Do not mark a project complete if build, browser QA, or visual QA fails.
- Do not deploy, commit, merge, or modify production settings during local build QA.
- Keep all secrets and `.env` files untouched.

## Builder Office Status Visibility

Display explicit status for each phase:
- Build: passed or failed
- Browser QA: passed or failed
- Visual QA: passed, failed, or needs review
- Screenshot artifacts: available or missing
- Automatic repair passes used: `N / 2`

## Verification

After changes:
```bash
npm run lint
npm run build
npm run worker:status
npm run nous:status
npx tsx scripts/queue-hermes-agent-test.ts
```

And a safe end-to-end smoke test on a generated project:
- run build
- start preview
- run browser QA
- capture screenshots
- report desktop/mobile results, issues found, fixes made, preview URL, remaining limitations

## Pitfalls

1. **Invalid Hermes flags**: Do not use `--oneshot` or other unverified flags. Always validate with `hermes.exe chat --help`.
2. **TypeScript in browser-qa.ts**: When adding `path` and `fs/promises` imports, use `import * as path from "node:path"` to avoid `TS1259` errors under stricter TS settings.
3. **Variable scope in browser QA**: Initialize `screenshotBase` and `consoleErrors` before the `try` block so they are in scope for the final return.
4. **Zod errors**: Pre-existing `TS1259` errors in `node_modules/zod/.../*.d.cts` are not caused by project code; do not edit `node_modules`.
5. **Local preview drift**: Always enforce the assigned preview URL in browser QA. Never let navigation escape to external sites.
6. **Window terminal mismatch**: Use POSIX commands in bash/MSYS on this Windows host. `dir /b /s`, `Get-ChildItem`, and PowerShell idioms fail; use `find`, `sed`, `rg`, `ls`, `cat` equivalents instead.

## References

See `references/technical-details.md` for exact CLI paths, valid flags comparison, repository-specific file map, and worker profile enforcement notes.
