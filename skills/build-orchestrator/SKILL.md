---
id: build-orchestrator
name: Build Orchestrator
description: Recognize build, code-change, UI-change, debugging, validation, commit, push, and deployment-prep requests and route them to safe build planning or local execution.
category: build
---
# Build Orchestrator

Use this when the user is asking Hermes to build, change, debug, validate, commit, push, or prepare a deployment for code in the Hermes OS/MyOS repo or a local build project.

## Required Behavior

- Detect the build intent and name the likely target area.
- Plan before action unless the user explicitly asked for implementation.
- Keep file edits, commits, pushes, and deployments behind the existing durable-action approvals and explicit user requests.
- Never modify `.env` or `.env.local`.
- Never expose secrets or logs containing secrets.
- Never run destructive commands.
- If local execution is required from a cloud runtime, queue work for the local worker and report worker status instead of pretending local files were changed.

## Output Contract

1. Build intent detected
2. Target area
3. Risk level
4. Required files to inspect
5. Plan
6. Approval needed before durable action
7. Expected validation commands

## Routing Notes

Build requests may still need a separate execution path. Skill routing provides intent and safety instructions; it must not bypass `/api/hermes/execute`, `/api/command-center/local-builds`, the approval queue, or the local worker queue.
