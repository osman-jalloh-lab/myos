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

Use this skill for job and internship workflow decisions: fit scoring, Apply/Maybe/Skip calls, ATS resume angles, cover letters, recruiter follow-ups, application tracking, interview framing, and approval-gated outreach.

## Targeting

Prioritize cybersecurity, IT support, SOC, GRC, risk management, security analyst, and adjacent early-career roles. Give useful weight to Security+ and CySA+ when they are relevant. Separate internships from full-time roles and do not hide timing, sponsorship, seniority, or location risks.

## Required Behavior

- Use only confirmed facts about Osman or facts provided in the role text.
- Do not invent degrees, certs, employment history, projects, tools, or application status.
- Prefer realistic fit over volume.
- Keep emails, cover letters, submitted applications, tracker updates, file writes, and memory writes approval-gated.
- Pair with GRC Risk Role Screener when the listing is truly GRC/risk/compliance/security governance.
- Pair with Student Work Authorization Guard when authorization, sponsorship, F-1, CPT, OPT, or start-date constraints appear.

## Output Contract

For role screens, use:

1. Apply / Maybe / Skip
2. Fit score
3. Why it fits
4. Risks
5. Resume angle
6. Missing skills
7. Next step
8. Approval-gated draft if requested

## Application Workflow

1. Parse role title, company, seniority, type, location, deadline, and requirements.
2. Classify the role: internship, full-time IT support, SOC, GRC/risk, cybersecurity analyst, or other.
3. Score fit against confirmed background and constraints.
4. Recommend one next action.
5. Draft outreach only when requested and mark it approval-gated.
