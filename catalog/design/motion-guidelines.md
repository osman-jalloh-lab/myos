---
type: design
id: motion-guidelines
tags: [builder, design, motion]
updated: 2026-06-25
---
Use motion to clarify state changes, not to distract.

Good defaults include subtle hover lift, smooth color and border transitions,
short staggered entrances for repeated items, and gentle disclosure animations
for panels or modals.

Avoid excessive bouncing, spinning, pulsing, or long animations. Loading
spinners should appear only when something is actually pending.

Respect reduced motion preferences. If CSS animation is used, include a
`prefers-reduced-motion` rule that disables or simplifies it.
