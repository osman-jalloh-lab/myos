---
type: skill
id: skill-scout-wcag-audit-patterns
updated: 2026-06-26
source: skill-scout
source_repo: wshobson/agents
source_path: plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md
recommended_action: add_qa_check
risk_level: low
---
# wcag-audit-patterns

## Source
Repository: wshobson/agents
Path: plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md
URL: https://github.com/wshobson/agents/blob/HEAD/plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md

## Recommended Action
add_qa_check

## Why It Helps Parawi
Catches keyboard, focus, contrast, label, and semantic regressions before generated apps ship.

## Guardrails
- Treat this as adapted guidance, not copied executable code.
- Do not run scripts from the source repository.
- Do not import secrets, binaries, lockfiles, build artifacts, or dependency folders.
- Expected Parawi touch points: catalog/design/accessibility.md, catalog/skills/frontend-qa.md

## Rollback
Revert the approved catalog/agent/src changes from the importing commit; no external repo files are executed during scouting.
