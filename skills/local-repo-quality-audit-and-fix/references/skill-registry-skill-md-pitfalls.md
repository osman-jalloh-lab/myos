# skill-registry-skill-md-pitfalls.md

Observed failure modes for Windows/OneDrive Hermes OS/MyOS repo skill validation/routing:

- `build-orchestrator quality: expected 15 to be greater than or equal to 90` — registry loads `SKILL.md` first; thin frontmatter makes `calculateSkillQualityScore` compute 15 because dense metadata is missing.
- `local-worker-status quality: expected 15 to be greater than or equal to 85` — same root cause as above.
- `taskType: 'hr_compliance' for "Fix the I-9 dashboard UI."` — `taskTypeFor()` matches `/i-?9/` first and returns early, swallowing a UI-fix/build request that mentions an HR domain string.
- `taskType: 'general' for "Check Vercel deployment."` — no regex path matches `deployment` explicitly in this context; broad fallback does not catch it.
- `taskType: 'general' for "Start a new pharmacy marketplace project."` — can happen when frontmatter `id` does not match the folder/file name, so registry discovery misses the skill.
- `approval-required intact: not all builder skills` — happens when `safetyClass` is absent; registry defaults to `read_only`.

Minimal fixes:

- Add full V2 metadata to folder-form `SKILL.md` frontmatter.
- Use canonical hyphenated IDs in frontmatter matching folder names.
- Add `category`, `ownerAgents`, `safetyClass`, `purpose`, `strongSignals`, `negativeSignals`, `whenToUse`, `whenNotToUse`, `outputContract`, `safetyRules`, `positiveExamples`, `negativeExamples`, `evaluationPrompts`.
- For mixed-domain UI/bug requests, ensure taskType prioritizes build intent when the message contains build verbs beside HR mention, or fix tests to match true behavior.
