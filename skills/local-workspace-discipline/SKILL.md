---
name: local-workspace-discipline
description: "Enforce write-boundary rules in local-first project folders: verify the root, validate with a write test, and never redirect work out of the declared workspace."
version: 0.1.0
---

platforms: []
license: MIT
# Local-Workspace Discipline

Use this before any build, scaffold, artifact, or write task when the target project claims a **local-first** boundary.

## Why this exists
Users often assign work to a specific project root and expect every artifact to live inside it. The fastest failure mode is generating content first and placing it elsewhere, especially on Windows desktop paths. Vercel, GitHub, sandboxes, and other repos are deployment/read targets, not workspace targets.

## Non-negotiables
1. **Resolve the root before writing anything.** Use `pwd`/`git rev-parse --show-toplevel` or equivalent, plus `find`/`ls` to confirm mounted disk presence.
2. **Validate the workspace is writable.** Create and immediately delete a sentinel file inside the intended project folder, e.g. `.local-write-test`. If this fails, stop.
3. **Use root-relative paths for all subsequent reads, writes, and edits.** Never use Duplicated home-desktop copies.
4. **Never redirect local work to a repository, cloud sandbox, or deployment platform.** Vercel/GitHub are optional, never prerequisites for local planning or builds.
5. **Do not commit, push, branch, change remotes, clone, or initialize git repos** unless the user explicitly requests it.
6. **Never edit `.env`, `.env.local`, credentials, tokens, secrets, or private keys.**

## Minimal checklist before any build task
- `pwd + git rev-parse --show-toplevel → confirmed root`
- `write_file sentinel → success`
- `delete sentinel → success`
- Only then start generation

## Verification
- Reply with the resolved absolute root path.
- List every file/directory you created or moved.
- If the user indicates the target is elsewhere, re-run root resolution; do not argue or cross-move between two assumed roots.

## Red flags that should trigger re-read of this skill
- User says "put it in the Hermes folder"
- User names a different project folder mid-task
- Root path is ambiguous due to spaces in folder names, OneDrive, or Desktop symlinks
- The user has local-write-test/sentinel or `AGENTS.md` style rules in the target folder

## Pitfalls
- Windows path confusions: use POSIX-style `/c/...` paths in bash shells; do not assume git-bash forwards `~/.env` reads when `read_file` is available.
- On OneDrive, confirm the path is actually mounted and not cloud-only; some folders show in `find` but reject writes.
- Never claim success based on `write_file` returning a path alone — verify with `ls -la` / `stat` after writes in sensitive locations.
- Confirming via filename search is not enough — use path traversal against the exact manifested path.
- Protected/bundled/herm-installed skills should never be edited unless the system explicitly allows.