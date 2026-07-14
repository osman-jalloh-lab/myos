---
name: email.draft
description: Queue an email draft for Osman's approval. Never sends automatically. Held in the Parawi approval queue until he explicitly approves. Requires a linked Google account.
---

# Email Draft (approval-gated)

Draft an email and place it in the approval queue. This skill never sends. Osman reviews and approves every draft before anything leaves.

## When to use
- Osman asks to reply to a recruiter, hiring manager, or interviewer.
- Osman asks for a follow-up, thank-you, or status-check email tied to a job or application.
- Osman asks to compose any outbound email that should wait for his review.

## When NOT to use
- Do not use to send, schedule, or auto-approve an email. This skill only queues.
- Do not use to read or triage the inbox. That is email.triage.

## Steps
1. Parse the recipient, intent, and any job or application context from the message.
2. Draft a clear, specific email in Osman's voice.
3. Queue the draft. Do not send. Return it for review.

## Rules
- Never send automatically. Approval-gated, always.
- No em dashes. No "excited to apply" or "great fit" phrasing.
- Send job-related mail from the ACC email address.
- Requires a linked Google account. If none is linked, say so instead of guessing.
