---
name: local-runtime-adapter
description: "Integrate a local machine runtime adapter for restricted agent execution, heartbeat visibility, and local-preview browser/vision QA."
version: 0.1.0
author: Hermes Agent
license: MIT
platforms: [windows]
metadata:
  hermes:
    tags: [Local-Worker, Hermes, QA, Browser, Windows]
    related_skills: [pr-packaging]
---

# Local Runtime Adapter

Class-level workflow for adapting a cloud-first agent stack to execute on a local Windows machine with strict boundaries.

## Trigger

Use this skill when:
- adding a local worker/heartbeat loop to a remote-first app
- wiring a CLI agent like Hermes into a controlled execution path
- restricting browser/vision QA to local previews only
- exposing executor readiness in an existing UI

## Hard Constraints

- default toolset: `terminal,file,browser,vision`
- exclude `web_search` from default toolset unless explicitly approved per task
- browser may navigate only to localhost, `127.0.0.1`, `0.0.0.0`, `[::1]`
- bind browser QA to the assigned preview URL for the project
- never commit screenshots, logs, or generated artifacts
- never deploy, merge to production, or modify production settings from this flow

## Pattern

### 1. Worker Heartbeat

- local worker publishes heartbeat to a SQLite-backed API
- heartbeat includes:
  - machine name
  - api target/base URL
  - current task
  - sanitized last error
  - auto-start installed state
  - auth/readiness flags for the wrapped CLI agent

- mark worker `online`, `offline`, or `stale`
- stale detection: probe saved preview URL; if unreachable, mark stale

### 2. Executor Routing

- preparatory actions always use the local worker
- later actions may choose local worker or remote agent
- honor environment-configurable allowlists, never hardcode beyond defaults

### 3. CLI Invocation Safety

- discover the installed CLI executable path:
  - Windows: `python.exe` beside the executable
  - `where.exe hermes-agent` fallback to PATH

- validate invocation before promotion:
  - one-shot probe
  - worker-style invocation with tool calls

### 4. Preview and Browser QA

- start local preview for the assigned project
- run Playwright browser QA:
  - desktop viewport `1440x900`
  - mobile viewport `390x844`
  - capture screenshots to a gitignored artifact path
  - record console errors

- enforce local-preview origin before navigation
- bind to assigned project preview URL when available

### 5. Visual QA Rubric

Evaluate each build against:
- no blank or broken sections
- no obvious clipping or horizontal overflow
- readable text and acceptable contrast
- clear visual hierarchy
- buttons look actionable
- spacing and alignment are consistent
- mobile layout is usable
- design matches the original build request

### 6. Repair Loop

- max 2 automatic repair iterations
- rerun browser QA after each repair
- mark complete only when browser QA and visual QA both pass
- record repair iterations used in project status

### 7. UI Readiness

Show:
- Local Worker status: `Online`, `Busy`, `Stale`, `Offline`
- Hermes Nous status: `Ready`, `Missing`, `Needs Login`, `Needs Model`, `Last Run Failed`
- machine name
- current task
- sanitized last error
- offline messaging when worker is unreachable
- screenshot and preview artifact links

### 8. Windows Auto-Start

Preferred auto-start: Windows Scheduled Task
- logon trigger
- restart on failure
- allow battery operation
- ignore new instances / no duplicates
- safe log rotation

Fallback: Startup-shortcut when Task Scheduler registration fails.

## Verification Sequence

1. run repo lints/tests relevant to touched areas
2. build the app
3. verify health endpoint
4. run CLI smoke checks with the installed local binary
5. queue a probe task through the repo test harness if available

Do not claim end-to-end success without:
- screenshots captured and saved locally
- browser QA recorded
- preview URL available
- visual rubric reviewed

## Pitfalls

- rotating screenshots under `artifacts/qa/` into git; keep them local-only
- trusting file timestamps for preview staleness; use HTTP probing
- using `--oneshot` or invalid CLI flags; validate with a one-shot probe first
- changing production settings, service workers, or remote deployment from local worker
- exposing secrets, tokens, or `.env` contents in UI status or logs
