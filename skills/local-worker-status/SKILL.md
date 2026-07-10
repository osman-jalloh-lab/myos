---
id: local-worker-status
name: Local Worker Status
description: Diagnoses whether the local Hermes worker, Ollama runtime, Hermes Nous runtime, and local execution loop are online, reachable, and processing jobs.
category: development
---
# Local Worker Status

Use this when the user is asking whether the local Hermes worker, Ollama runtime, Hermes Nous runtime, or local execution loop is reachable, online, offline, stale, or processing jobs.

## Required Behavior

- Answer in a read-only diagnostic mode unless the user explicitly asks to mutate worker state or retry jobs.
- If the app cannot verify the local worker from cloud, state that clearly and instruct the user to run the worker locally.
- Never expose secrets, tokens, raw env values, sensitive logs, or private paths beyond safe labels.
- Do not call localhost from Vercel or the browser as a shortcut for diagnostics.
- Do not start, stop, restart, or mutate jobs without an explicit user request and existing approval path.

## Output Contract

1. Worker status
2. Queue status
3. Last heartbeat
4. Last job claimed
5. Last job completed
6. Ollama status if available
7. Likely cause
8. Next step

## Routing Notes

This skill is secondary when the user wants implementation, not diagnostics. If the user is reporting a failed build, default to `build-orchestrator` first and only use this skill for worker/queue/Ollama diagnostics.
