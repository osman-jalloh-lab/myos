# Skill registry

One home for all skills, provider-agnostic. Each skill is a folder with a SKILL.md
(name + description frontmatter + instructions, optional scripts). Hermes runs
`skill-match` against these descriptions before a task and attaches the matched skill.

- Claude execution: upload these via the Claude /v1/skills API; Claude auto-invokes by description.
- OpenAI execution: Hermes injects the matched skill's instructions and registers its scripts as tools.

Drop your existing skills here (i9-hr-specialist, humanizer, job-application-ops, etc.).
SECURITY: only add skills you authored or got from Anthropic. Audit every SKILL.md before use.
