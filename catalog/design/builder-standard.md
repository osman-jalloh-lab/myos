---
type: design
id: builder-standard
tags: [builder, design, qa, standard]
updated: 2026-06-25
---
Builder output is not complete just because npm build passes.

Every button must do something visible. A button can open a panel, change state,
filter data, save a choice, submit a form, reset a view, navigate to a real
target, or show useful feedback. Never generate dead buttons.

Every app needs loading, empty, and error states for its main workflow. Demo
apps can simulate these states locally, but the states must be visible and
credible.

QA must pass before the app is treated as complete. Mobile must work without
overlap or horizontal overflow. Interactions must feel real enough that a user
understands the product by clicking through it.
