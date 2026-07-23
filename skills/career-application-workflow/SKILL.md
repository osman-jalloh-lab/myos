---
name: career-application-workflow
description: "Job application materials and workflow: resumes, cover letters, application emails, and tracking for cybersecurity, GRC, IT support, and HR roles."
version: 0.1.0
author: Hermes Agent
license: MIT
metadata:
  user: yash-osman-jalloh
  domain: career
  campaign_type: job_search
---

platforms: []
# Career Application Workflow

Use this skill for all job application tasks: resume edits, cover letters, outreach emails, role fit checks, and application tracking.

## Trigger

Load when the request is any of the following:
- resume review, edit, or rewrite
- cover letter draft
- job application email or message
- role fit / match assessment
- application tracking or campaign management
- LinkedIn outreach or networking for job search

## Hard Constraints

These are non-negotiable. Violations are errors, not style deviations.

- No em dashes (—) anywhere. Use commas, periods, or parentheses instead.
- Never use these phrases or close variants:
  - "excited to apply"
  - "passionate about"
  - "great fit"
  - "leverage"
  - "utilize"
  - "delve"
  - "pivotal"
- Cover letters: strictly under 250 words.
- Resumes: strictly one page.
- Tone default: direct, concise, no fluff.

## Output Standards

### Resume bullets
- Lead with action verbs.
- Prefer one line; max two lines.
- Quantify impact when possible.
- Cut anything that does not match the target description.

### Cover letters
- Short paragraphs only.
- Address the hiring manager when the name is known.
- Match 1-2 specific role requirements with evidence from the user's background.
- Plain call to action in the closer.
- 250 words is a hard ceiling.

### Outreach / emails
- Subject: clear and specific.
- Body: 3-5 sentences max.
- State role, company, and one qualification hook.
- Only attach or link materials when prompted.

## Workflow

1. Get the exact job description or role text. If missing, ask before drafting.
2. Identify the top 3-4 matched qualifications.
3. Resume: trim to one page around those matches.
4. Cover letter: draft under 250 words, then self-check banned phrases and em dashes before showing output.
5. Outreach: draft short message, then deliver.
6. Present final text. Explain changes only if asked.

## Anti-Patterns

- Generic templates that ignore the specific job description.
- Filler openers like "I am writing to express my interest..."
- Repeating banned phrases or em dashes in any output.
- Surfacing the same draft twice without changes.
