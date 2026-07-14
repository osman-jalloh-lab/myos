---
name: email.triage
description: Fetch and triage Osman's inbox. Scans recent mail for action-needed items like job follow-ups, recruiter replies, interview requests, and deadlines. Read-only. Requires a linked Google account.
---

# Email Triage (read-only)

Scan the inbox and surface what needs action, in priority order. This skill reads only. It never drafts or sends.

## When to use
- Osman asks what is in his inbox, what needs a reply, or what he is missing.
- Osman asks for recruiter replies, interview requests, or job follow-ups.
- Osman asks about deadlines or time-sensitive mail.

## When NOT to use
- Do not use to write or send a reply. Hand off to email.draft for that.
- Do not use for non-email tasks or reminders. That is task.create.

## Steps
1. Fetch recent inbox messages through the linked Google account.
2. Flag action-needed items: recruiter replies, interviews, deadlines, follow-ups.
3. Return a short prioritized list. Do not draft or send anything.

## Rules
- Read-only. No drafting, no sending from this skill.
- Screen career items against Osman's real goals and constraints before flagging.
- Requires a linked Google account. If none is linked, say so.
