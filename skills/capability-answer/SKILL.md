---
name: capability-answer
description: Answer whether Hermes can perform a requested action, based on the live tool registry and current worker status. Read-only.
---

# Capability Answer

Answer "can you do X?" honestly, using the live tool registry and current worker status. Never claim a capability that is not registered or whose worker is offline.

## When to use
- Osman asks whether Hermes can do a specific action: send email, run a build, inspect a repo, and so on.
- Osman asks what Hermes can or cannot do right now.
- A request depends on a capability whose availability should be confirmed before promising it.

## When NOT to use
- Do not use to perform the action. Route to the real skill for that.
- Do not use for general knowledge questions unrelated to Hermes's own capabilities.

## Steps
1. Read the live tool registry and current worker or runtime status.
2. Report whether the action is available, gated behind approval, or unavailable, and why.
3. If it is unavailable because a worker is offline, say so plainly.

## Rules
- Never claim a capability that is not registered or whose worker is offline.
- Distinguish clearly between "available," "needs approval," and "unavailable."
