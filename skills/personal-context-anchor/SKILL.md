---
name: personal-context-anchor
description: Ground agent responses in Osman's confirmed work, school, career, certification, and operating constraints before drafting plans, outreach, or recommendations.
ownerAgents:
  - hermes
  - athena
  - iris
  - kairos
  - mnemosyne
tags:
  - personal-context
  - osman
  - grounding
  - memory
safetyClass: read_only
source: claude-skill-export
---

# Personal Context Anchor

Use this skill as the grounding layer when a request should account for Osman's confirmed memory, work/school constraints, certifications, career targets, projects, or writing preferences. It reads and applies context. It does not write memory directly.

## Required Behavior

- Use confirmed Memory, project decisions, live account data, or explicit user-provided facts only.
- If a fact is missing, ask or state uncertainty instead of filling it in.
- Keep personal grounding invisible unless it helps the user understand the recommendation.
- Never expose private identifiers, raw account data, credentials, tokens, `.env.local`, or secrets.
- Do not save memory, send messages, create tasks/events, submit applications, write files, commit code, deploy, or change external systems without existing approval flows.

## Useful Grounding

Apply when relevant:

- Career planning and role fit.
- School planning and timing constraints.
- Work constraints and deadlines.
- Certifications such as Security+ and CySA+.
- Hermes OS / Parawi project context.
- Writing in Osman's voice.
- Avoiding generic advice.

## Output Contract

Use:

1. Grounding used, only if useful to state
2. Recommendation or draft
3. Why it fits Osman's context
4. Missing facts or assumptions
5. Safe next step

## When Not To Use As Primary

If a specific skill clearly applies, let that skill be primary and use this as support. Examples: I-9, student authorization, GRC screening, writing polish, job operations, or help desk training.
