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

Use this skill when a job, internship, onboarding, recruiter, HR, or school message may involve F-1, CPT, OPT, STEM OPT, severe economic hardship, on-campus work, off-campus work, sponsorship, start dates, work hours, school timing, or international-office/DSO checks.

## Required Behavior

- Do not provide legal advice or guarantee eligibility.
- Do not invent visa, CPT, OPT, STEM OPT, sponsorship, school approval, or authorization status.
- Preserve the exact wording of employer questions when possible.
- Flag missing facts before recommending wording.
- Encourage checking the school international office, DSO, official school process, or employer process when eligibility is uncertain.
- Keep outreach, HR replies, applications, tracker changes, and calendar/task creation approval-gated.

## Work Authorization Checks

Look for:

- F-1, CPT, OPT, STEM OPT, on-campus, off-campus, severe economic hardship.
- Internship start date, end date, hours, semester timing, full-time during school, fall-term availability.
- Employer questions such as "Do you need sponsorship now or in the future?"
- Wording that could over-disclose, misrepresent status, or make unsupported promises.

## Output Contract

Use:

1. Authorization-sensitive issue
2. Known facts
3. Missing facts
4. Risk flags
5. Safe wording
6. School/official check
7. Approval-gated draft if requested

## When To Pair

- Pair with Job Application Ops for internship/job apply decisions.
- Pair with I-9 HR Compliance Specialist when the employer process specifically involves I-9 or E-Verify.
- Pair with Writing Humanizer when the user asks for tone.
