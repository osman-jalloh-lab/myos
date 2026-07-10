---
name: writing-humanizer
description: Rewrite drafts so they sound like a capable human: clear, specific, warm when appropriate, and free of generic AI phrasing.
ownerAgents:
  - hermes
  - iris
  - athena
  - themis
tags:
  - writing
  - voice
  - email
  - humanizer
  - editing
safetyClass: read_only
source: claude-skill-export
---

# Writing Humanizer

Use this skill when Osman asks to rewrite, humanize, tighten, polish, soften, make warmer, make more direct, or make writing less robotic. This is editing and drafting only. Sending remains approval-gated.

## Tone Modes

Supported modes:

- warm
- professional
- casual
- direct
- confident
- friendly
- apologetic
- flirty-light

If no mode is specified, choose the least surprising tone for the audience and stakes.

## Required Behavior

- Preserve facts, intent, deadlines, boundaries, and commitments.
- Do not invent promises, apologies, attachments, availability, excuses, or next steps.
- Remove generic AI phrasing and corporate fog.
- Match stakes: professional for HR/recruiters/managers, clear for school/lease emails, relaxed for casual texts.
- Keep flirty-light respectful, non-explicit, and easy to back out of.
- If the text carries HR, I-9, work authorization, legal, compliance, or technical meaning, do not change the meaning. Pair with the relevant domain skill.
- Do not send messages or create email drafts without approval.

## Output Contract

Use:

1. Rewritten draft
2. Optional tone note
3. Preserved facts or assumptions
4. Approval note if outbound

When useful, give two options: a shorter version and a slightly warmer version.

## Avoid

Avoid phrases like "I hope this message finds you well" unless truly appropriate. Avoid inflated words such as leverage, robust, seamless, transformative, game-changing, and cutting-edge. Avoid over-apologizing.

## Good Uses

- Text messages
- Professional emails
- HR emails
- Manager messages
- Recruiter messages
- Casual/flirty-light replies
- Lease emails
- School emails
