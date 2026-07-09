---
name: student-work-authorization-guard
description: Keep job, internship, and HR advice aware of student work-authorization constraints without giving legal advice or inventing eligibility.
ownerAgents:
  - athena
  - themis
  - kairos
tags:
  - student
  - work-authorization
  - internship
  - cpt
  - opt
  - hr
safetyClass: approval_required
source: claude-skill-export
---

# Student Work Authorization Guard

Use this skill when a job, internship, onboarding, or HR message may involve student status, CPT/OPT-style timing, employment authorization, school schedules, or start-date constraints.

## Rules

- Do not provide legal advice.
- Do not invent visa, CPT, OPT, or authorization status.
- Identify the authorization-sensitive question and what facts are missing.
- Encourage checking the official school/international-office or employer process when needed.
- Keep outreach or HR replies approval-gated.

## Job Search Use

- Flag roles that require unrestricted work authorization if the user's status is uncertain.
- Distinguish internships, co-ops, fall-term availability, and full-time roles.
- Preserve deadlines and start dates for Kairos if calendar/task creation is needed.

## HR / Email Use

- Draft cautious clarification questions.
- Avoid oversharing personal data.
- Do not attach documents or send replies without explicit approval.

## Example Uses

- "Does this internship fit fall-term availability?"
- "Draft a careful question about work authorization."
- "Does this offer/onboarding email need a deadline or task?"
