---
name: github.inspectRepo
description: Inspect a public GitHub repository. Fetch metadata, language, stars, forks, topics, license, and a README preview from a GitHub URL. Read-only.
---

# GitHub Repo Inspector

Given a GitHub URL, return a quick read on the repo. Read-only. No cloning, no writes.

## When to use
- Osman pastes a GitHub URL and wants a quick read on the project.
- Osman asks about a repo's language, activity, or license before using it.
- Research on a tool or dependency that lives on GitHub.

## When NOT to use
- Do not use to clone, edit, build, or run repo code. That is the builder and worker path.
- Do not use for private repos or anything needing auth beyond public metadata.

## Steps
1. Extract the GitHub URL from the message.
2. Fetch public metadata: language, stars, forks, topics, license, README preview.
3. Return a short summary. Do not clone or modify anything.

## Rules
- Read-only, public metadata only.
- If the URL is missing or malformed, ask for a valid GitHub URL.
