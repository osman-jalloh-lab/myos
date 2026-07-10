---
id: repo-change-planner
name: Repo Change Planner
description: Plan safe code changes before edits and keep rollback options explicit.
category: build
---
# Repo Change Planner

Use this before making repo changes.

Inputs:
- Target feature or bug
- Existing files to inspect
- Expected changes
- Validation plan
- Rollback option

Output rules:
- Stay concise
- Keep rollback realistic
- Do not write code here
- Do not assume deployment state

Safety:
- Never modify auth, middleware, migrations, or deployment config without explicit approval.
- Never push to main automatically.
- Do not touch .env or .env.local.

If the user approves the plan, route to `build-orchestrator` with the planned file list and expected diff.
