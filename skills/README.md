# Skill registry

One home for Hermes OS skills, provider-agnostic. Skills are safe routing and
instruction intelligence first. They do not bypass approvals, auth, or durable
action gates.

Hermes supports:

- Legacy `/skills/*.json` files.
- Folder skills with `SKILL.md` instructions.
- V2 metadata in JSON or `SKILL.md` frontmatter.
- Installed, local, and scouted skills.

## V2 metadata

Core personal skills now include richer fields:

- `purpose`
- `whenToUse`
- `whenNotToUse`
- `strongSignals`
- `weakSignals`
- `negativeSignals`
- `requiredContext`
- `missingContextQuestions`
- `outputContract`
- `safetyRules`
- `approvalRequiredFor`
- `positiveExamples`
- `negativeExamples`
- `evaluationPrompts`
- `version`
- `lastReviewedAt`

The registry computes a separate `skillQualityScore` from 0 to 100. Match
confidence still means "how well this request matches right now"; quality means
"how complete, safe, tested, and useful this skill definition is."

## Safety rules

- Skills are guidance and routing intelligence.
- Sending email, creating calendar events, writing files, submitting
  applications, modifying external systems, committing code, deploying, and
  durable memory writes must still use existing approval flows.
- Scouted skills are not executable by default.
- Do not expose secrets or print `.env.local`.

## Core personal skills

- `i9-hr-compliance-specialist`
- `student-work-authorization-guard`
- `job-application-ops`
- `grc-risk-role-screener`
- `personal-context-anchor`
- `writing-humanizer`
- `it-help-desk-trainer`

Run the skill eval suite with:

```bash
npm run test -- src/lib/__tests__/skills-quality.test.ts src/lib/__tests__/skills-routing-v2.test.ts
```
