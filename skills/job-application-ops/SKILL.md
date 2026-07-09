---
name: job-application-ops
description: Manage job-search operations: fit checks, ATS-aware resume/cover-letter drafting, application tracking, recruiter follow-ups, and approval-gated outreach.
ownerAgents:
  - athena
  - iris
  - hermes
tags:
  - jobs
  - applications
  - resume
  - cover-letter
  - ats
  - recruiters
safetyClass: approval_required
source: claude-skill-export
---

# Job Application Ops

Use this skill for job applications, recruiter messages, resume tailoring, cover letters, ATS scoring, and follow-up tracking. It reuses the existing Athena job pipeline and ApprovalAction-gated outreach.

## Osman's Targeting

- Prioritize cybersecurity, IT support, SOC, GRC, risk management, and adjacent analyst roles.
- Give extra weight to roles matching Security+ and CySA+.
- Keep fall-term internships separate from full-time roles.
- Prefer realistic fit over volume.

## Workflow

1. Parse the role and company.
2. Identify category: fall internship, full-time IT, SOC, GRC/risk, cybersecurity analyst, or other.
3. Score fit against Osman's certs, experience, and constraints.
4. Produce resume/cover-letter guidance only when there is enough role detail.
5. Track application status through the existing app tracker.
6. Put recruiter replies, cover-letter sends, or application outreach in ApprovalAction. Never auto-send.

## Output Expectations

- Lead with whether the role is worth pursuing.
- Explain the fit in concrete terms.
- Name missing skills without discouraging him.
- Keep drafts natural and specific.
- Do not invent employment history, degrees, certs, or project claims.

## Example Uses

- "Score this SOC analyst listing."
- "Draft a recruiter follow-up."
- "Tailor my resume for this GRC role."
- "Track this job as interested."
