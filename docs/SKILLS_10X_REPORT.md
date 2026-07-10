# Skills 10X Upgrade Report

Generated: 2026-07-10

## Summary

| Skill | Quality | Routing Accuracy | Safety | Status |
|---|---:|---|---|---|
| I-9 HR Compliance Specialist | 100 Excellent | Eval pass | Approval required | Upgraded |
| Student Work Authorization Guard | 100 Excellent | Eval pass | Approval required | Upgraded |
| Job Application Ops | 100 Excellent | Eval pass | Approval required | Upgraded |
| GRC Risk Role Screener | 100 Excellent | Eval pass | Read-only guidance | Upgraded |
| Personal Context Anchor | 100 Excellent | Eval pass | Read-only guidance | Upgraded |
| Writing Humanizer | 100 Excellent | Eval pass | Read-only guidance | Upgraded |
| IT Help Desk Trainer | 100 Excellent | Eval pass | Read-only guidance | Upgraded |

## Old vs New

Old scores are estimated from the previous metadata shape: short descriptions,
tags, owner agents, examples, safety class, and short SOP text. The new score is
computed by `calculateSkillQualityScore`.

| Skill | Old Quality | New Quality | What Improved |
|---|---:|---:|---|
| I-9 HR Compliance Specialist | 60 | 100 | Added I-9/E-Verify document signals, no-legal-advice rules, employee-choice rule, output contract, eval prompts. |
| Student Work Authorization Guard | 55 | 100 | Added F-1/CPT/OPT/STEM OPT signals, school/DSO checks, start-date handling, cautious wording, eval prompts. |
| Job Application Ops | 62 | 100 | Added Apply/Maybe/Skip contract, fit scoring, ATS/resume/outreach gates, job vs GRC vs authorization distinctions. |
| GRC Risk Role Screener | 60 | 100 | Added SOC 2/NIST/RMF/ISO/control signals and distinctions between IT GRC, finance risk, legal compliance, and senior audit. |
| Personal Context Anchor | 58 | 100 | Added confirmed-memory grounding rules, privacy limits, when not to expose details, and support-role behavior. |
| Writing Humanizer | 52 | 100 | Added full `SKILL.md`, tone modes, fact-preservation rules, negative signals, and eval prompts. |
| IT Help Desk Trainer | 52 | 100 | Added full `SKILL.md`, troubleshooting templates, ticket/escalation formats, safety rules, and eval prompts. |

## Skill Details

### I-9 HR Compliance Specialist

- Top triggers: Form I-9, I-9 email, E-Verify, Section 1/2/3, TNC, reverification, I-797A/C, I-94, EAD.
- When not to use: general writing, student authorization only, legal advice, automatic HR/E-Verify action.
- Safety class: approval required.
- Eval: pass.
- Known limitation: deterministic matching cannot interpret attached HR documents unless their text is present.

### Student Work Authorization Guard

- Top triggers: F-1, CPT, OPT, STEM OPT, sponsorship question, authorization on application, internship timing.
- When not to use: general job fit with no authorization issue, pure I-9/E-Verify procedure, legal advice.
- Safety class: approval required.
- Eval: pass.
- Known limitation: it cannot know actual immigration status unless provided or confirmed.

### Job Application Ops

- Top triggers: fit score, should I apply, Apply/Maybe/Skip, ATS resume tailoring, recruiter message, application tracking.
- When not to use: pure GRC, I-9, CPT/OPT, help desk ticket, or writing-only tasks.
- Safety class: approval required.
- Eval: pass.
- Known limitation: role scoring improves when full listing text is available.

### GRC Risk Role Screener

- Top triggers: GRC, risk management, SOC 2, NIST, RMF, ISO 27001, controls testing, audit evidence.
- When not to use: finance risk, legal compliance, senior audit ownership, general outreach tone.
- Safety class: read-only guidance.
- Eval: pass.
- Known limitation: ambiguous "risk" roles still need listing details to separate IT/security GRC from finance/legal risk.

### Personal Context Anchor

- Top triggers: my background, my voice, use my context, Security+, CySA+, career planning, school planning.
- When not to use: as primary for a more specific skill, saving memory directly, exposing private details.
- Safety class: read-only guidance.
- Eval: pass.
- Known limitation: only confirmed memory or user-provided facts should be used.

### Writing Humanizer

- Top triggers: make this sound human, less robotic, rewrite this, fix the tone, flirty-light, recruiter/HR/lease/school email.
- When not to use: as primary for compliance correctness, work authorization analysis, GRC screening, or IT troubleshooting.
- Safety class: read-only guidance.
- Eval: pass.
- Known limitation: facts and commitments must be supplied by the user or context.

### IT Help Desk Trainer

- Top triggers: help desk, ticket note, troubleshooting steps, Active Directory, VPN, MFA, printer, cannot log in.
- When not to use: GRC screening, HR/I-9, work authorization, or pure writing tone.
- Safety class: read-only guidance.
- Eval: pass.
- Known limitation: it drafts/coaches only and cannot modify real systems or tickets.

## UI/API Changes

- Command Center Skills API returns `skillQualityScore`, `skillQualityBand`, v2 signal fields, output contracts, safety rules, eval prompts, and registry quality summary.
- Skills page shows quality score, primary safety metadata, expanded routing signals, output contract, safety rules, eval examples, last used, and usage count.
- Test Match now returns matched signals, negative matches, missing-context questions, and quality metadata.

## Routing Changes

- Resolver now returns `primarySkill`, `supportingSkills`, `rejectedSkills`, `qualityWarnings`, `missingContextQuestions`, and `explanation`.
- Specific skills beat broad support skills when both match strongly.
- Supporting skill pairing is deterministic for GRC plus job/personal context, student authorization plus job ops, I-9 plus writing, and help desk plus writing.
- `skillInstructionBlock` includes primary skill, supporting skills, safety rules, approval requirements, missing-context questions, and output contract.

## Validation

- `skills-quality.test.ts`: pass.
- `skills-routing-v2.test.ts`: pass.
- Existing skills registry/routing tests: pass.

Full project validation status is reported in the final Codex response.
