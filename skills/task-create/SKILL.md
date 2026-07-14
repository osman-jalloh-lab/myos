---
name: tasks.create
description: Create a task in Parawi/MyOS. Parses a title and optional due date from Osman's message. Use for reminders, follow-ups, and to-dos.
---

# Create Task

Turn a request into a task in the MyOS task system. Parse a title and, if present, a due date.

## When to use
- Osman says to remind him, add a to-do, or follow up on something.
- Osman gives a task with a date or deadline attached.
- A conversation produces a clear next action worth tracking.

## When NOT to use
- Do not use to send email or take any external action. Those are their own skills.
- Do not use to fabricate a due date. If none is given, leave it empty.

## Steps
1. Parse the task title from the message.
2. Parse an optional due date if one is stated. Do not invent one.
3. Create the task and confirm what was captured.

## Rules
- No em dashes in the task text.
- Only capture what Osman actually said. No invented dates or details.
