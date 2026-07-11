---
id: project-starter
name: Project Starter
description: Guided skill for starting a new project from idea through architecture into first build plan.
category: build
safetyClass: internal_write
execution:
  tool: internal.projects.create
  risk: internal_write
  requiresApproval: false
  pipeline:
    - internal.projects.create
    - internal.projects.plan
    - internal.projects.requestHandoff
---
# Project Starter

Use this when the user wants to start a project from idea to architecture to first build plan.

Be a partner, not a chatbot. Ask the minimum needed to unblock architecture. Do not start listing files or scaffolding unless the user explicitly asks.

Intake rules:
- Assume a Next.js/TypeScript web app unless the user says otherwise.
- Ask one focused architecture question only when you are missing a required field.
- Return a structured plan when you have enough context.

Required context:
- Project name
- Goal
- Target users
- Core features
- Data model sketch
- Pages/routes
- Tools needed
- MVP plan
- Build phases
- Risks
- First implementation step

If the user approves implementation after the plan, route to `build-orchestrator` for implementation with the generated plan as input.
