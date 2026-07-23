---
name: agent-tool-profile-enforcement
title: Agent Tool Profile Enforcement
description: Enforce stage-appropriate tool boundaries when dispatching an external agent CLI from a worker/queue. Use when building local-worker execution, task-queue profiles, QA isolation, or browser restriction policies.
---

platforms: []
version: 0.1.0
license: MIT
# Agent Tool Profile Enforcement

Use when a worker/queue process invokes an external agent CLI (Hermes, Codex, Claude Code, etc.) and that agent's tool access must vary by pipeline stage: research/build/local QA/visual review.

## Prerequisites

- External agent CLI invoked from a worker process, not client code
- Task or job description available at dispatch time
- Ability to pass a toolset/tool-allowlist to the CLI
- Prefer explicit `executionProfile` on the queued task; do not infer from free-text prompt alone

## Step 1: Define explicit profiles

Create a single pure policy module that defines:

- `ToolProfile` union
- `TOOL_PROFILES: Record<ToolProfile, string[]>`
- One resolver: `resolveProfileForAction(action, executionProfile)` with safe default `build`
- Localhost checker / allowlist regex, if browser QA must be constrained to local preview

Profile shapes:

| Profile | Allowed tools |
|---|---|
| `research` | `terminal,file,browser,vision,web_search` |
| `build` | `terminal,file` |
| `qa` | `terminal,file,vision` |
| `visual_review` | `terminal,file,vision` |
| `noop` | `[]` |

## Step 2: Map action → profile

Explicit mapping:

- `research` action or profile `research` → `research`
- `generate`, `fix`, `rebuild`, `build`, `npmBuild` → `build`
- `browser qa`, `browser QA` → `qa`
- `screenshot review`, `visual review` → `visual_review`
- Unknown / missing → `build`

Never infer profile only from free-text body. Store explicit `executionProfile` on the queued task.

## Step 3: Worker enforcement

In `scripts/hermes-local-worker.ts`:

1. Extend `QueueTask` with `executionProfile: string | null`.
2. Read `execution_profile` from DB in `claimTask` with null-safe assignment.
3. Before invoking the agent CLI, resolve allowed tools from the policy module.
4. Pass only those tools to `hermes.exe chat -q ... --cli -t <toolset>`.
   Do not pass browser/web_search to QA Hermes without an enforced domain allowlist.
5. Log the selected profile and allowed tools in sanitized task logs.

## Step 4: Browser restriction architecture

**Do not claim the restriction is enforced unless it is implemented in code.**

- **Research:** use a clean isolated browser session, no personal data, cookies, saved logins, or side-effect targets.
- **Local QA:** block external URL navigation; enforce localhost-only via regex/assertion in `lib/browser-qa.ts`:
  - `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` only.
  - Desktop 1440x900 and mobile 390x844 viewports.
  - Write screenshots to gitignored paths and return explicit paths.
  - Hermes receives `terminal,file,vision` only for local QA, not browser.
- **Visual review:** Hermes receives `vision` but not `browser`.

## Step 5: Tests required

Cover at least:

- `research` gets browser and `web_search`
- `build` gets neither browser nor `web_search`
- `local_qa`/`qa` gets vision but not browser
- `visual_review` gets vision but not browser
- Unknown profile falls back to `build`
- Hermes invocation args use the resolved toolset
- Navigation to non-localhost is rejected by browser QA

## Step 6: Verify

```bash
npm test
npm run lint
npm run build
```

If `npm run build` reports stale type errors from `scripts/*.ts` after a clean `npm test`:
```bash
rm -rf .next node_modules/.cache
npm run build
```

Interpret build exit code, not log wording. Exit 0 = gate passed.

## Pitfalls

- **Action-to-toolset mapping alone is not enforcement:** profile selection must actually filter CLI args.
- **Localhost checks are not optional:** keep the allowlist strict and canonical.
- **Local QA without browser:** never hand browsing to Hermes local QA without an enforceable domain allowlist implemented in code. Use Playwright for browsing and pass Hermes only `terminal,file,vision`.
- **Stale worker credential/agent-run execution directories:** no-op profiles won't deadlock builds.
- **Worker queue schema drift:** if `execution_profile` is not present in the DB, run migration SQL or seed it. Missing column → null-safe fallback to build.
- **Auth/config exposure:** ensure `executionProfile` or other metadata cannot include raw credentials or tokens; store only safe identifiers like profile names and timestamps.
