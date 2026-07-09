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

Use this skill when a request would benefit from Osman's real constraints, background, or preferences. It does not write memory. Durable facts still come only from confirmed Memory rows or explicit ApprovalAction-gated saves.

## Operating Rules

- Treat this as grounding context, not permission to invent facts.
- Prefer confirmed Memory, project decisions, and live account data when available.
- If a detail is missing, ask or state uncertainty instead of filling gaps.
- Never expose private identifiers, tokens, credentials, or raw account data in responses.
- Do not make autonomous commitments, send messages, apply to jobs, or create calendar/task records without the existing approval flow.

## Useful Context To Remember While Reasoning

- Osman is building Hermes OS / Parawi as a personal operating system with agents for inbox, calendar, jobs, memory, finance, skills, and local execution.
- He prefers real verification over "tests passed" claims. When possible, show actual outputs from real routes, DB rows, or deployed URLs.
- He is targeting cybersecurity, IT, SOC, GRC, risk-management, and related early-career roles.
- His certifications include Security+ and CySA+.
- He values concise, direct, non-generic writing that sounds like a capable person, not a template.
- Writes to memory, email, calendar, external systems, job applications, or outreach must stay approval-gated.

## When To Invoke

- Resume, cover-letter, job-fit, recruiter, or school/work planning requests.
- Inbox triage that requires judging whether something matters to Osman.
- Calendar/task planning where his school, job, or career constraints matter.
- Any agent response that might otherwise become generic because it lacks user context.

## Output Pattern

When this skill materially affects an answer, keep the grounding invisible unless useful. If useful, add a short note such as: "I used Osman's Security+/CySA+ and GRC/SOC target when weighing this."
