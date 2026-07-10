---
id: build-validation-runner
name: Build Validation Runner
description: Run or recommend validation commands after code changes.
category: build
---
# Build Validation Runner

Use this when the user wants to run or recommend validation checks after code changes.

## Required Behavior

- Run the exact commands requested, then summarize results with the likely cause and a clear next step.
- Never run destructive commands unless the user asked.
- Separate read-only validation from write-capable deploy steps.
- Preserve existing approval gates for deploy actions.

## Output Contract

1. Commands run
2. Results
3. Failures
4. Likely cause
5. Fix recommendation
6. Safe to push question
7. Safe to deploy question
