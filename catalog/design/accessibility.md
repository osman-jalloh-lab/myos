---
type: design
id: accessibility
tags: [builder, design, accessibility, qa]
updated: 2026-06-25
---
Use semantic HTML first. Buttons perform actions. Links navigate. Forms use
labels. Sections have useful headings.

Keyboard navigation must work for primary workflows. Focus states must be
visible and not removed.

Maintain readable contrast for text, borders, and interactive states. Do not
put low contrast text over busy backgrounds.

Use aria only when it adds useful information or repairs a custom interaction.
Do not add noisy aria labels to elements that are already clear.
