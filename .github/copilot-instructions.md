# Copilot instructions — Hermes OS

Before generating code, read and follow these repo files:
1. `CLAUDE.md` — canonical operating rules (stack, 7 agents, non-negotiables, build stages).
2. `context/about-osman.md` — who this is for + writing rules.
3. `docs/HERMES_OS_MASTER_SPEC.md` — what to build.

Honor every non-negotiable: server-side OAuth; each agent owns ONLY its own tools; no writes
until the approval queue exists; default to Groq; log every LLM call; build in stages and STOP
after each. Do not invent features ahead of the current stage.
