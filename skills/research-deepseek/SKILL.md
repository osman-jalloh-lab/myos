---
name: research-deepseek
description: Ask DeepSeek directly for public, non-sensitive research or to draft skills, plans, outlines, and code snippets. Use when Osman explicitly asks for DeepSeek or wants a cheap research/build-drafting model. Never use for PRIVATE or SECRET content, automatic repo reads, or durable writes.
---

# DeepSeek Research and Drafting

Use DeepSeek as a single-provider research and drafting tool for public, non-sensitive material.

## Workflow

1. Pass only the user's explicit prompt. Do not attach memory, private context, or repo files automatically.
2. Let the shared data classifier refuse PRIVATE or SECRET content before any provider call.
3. Return DeepSeek's answer as advisory text only.
4. Route requested file edits, skill creation, commits, pushes, or deployment through the existing approval-gated build path.

## Boundaries

- Draft research, skill content, plans, outlines, and code snippets only.
- Never send I-9, E-Verify, finance, payroll, email content, SSNs, EINs, credentials, or classifier-flagged data.
- Never read repo files automatically. A specific file requires deliberate per-file opt-in and must contain no secrets or personal data.
- Never claim to create, edit, commit, push, or deploy anything.
