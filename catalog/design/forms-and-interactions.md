---
type: design
id: forms-and-interactions
tags: [builder, design, forms, interactions]
updated: 2026-06-25
---
Forms and interactions should work in demo mode.

Validate required fields and show helpful messages. Submit buttons need disabled
and loading states when work is pending. Success and error feedback should be
visible near the action.

Use localStorage persistence when a demo app needs saved items, settings,
comparison lists, draft state, or user preferences. Guard localStorage for the
browser runtime.

Filters, modals, tabs, cards, drawers, menus, and detail panels should be
clickable and should visibly change the interface.
