# Hermes Local CLI Verification on Windows

## Purpose
Use when wiring Hermes into a local worker, scheduler, or wrapper where invalid
flags silently break execution or queue jobs forever.

## Observed failure mode
Using an older/undocumented invocation like `hermes --oneshot ...` against a
modern local Hermes install returned exit 0 without doing the requested work,
because that flag is not supported by the installed binary.

## Fast validation recipe
1. Resolve the binary:
- `where.exe hermes.exe`
- fallback path: `C:\Users\<user>\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe`
2. Inspect flags:
- `"<binary>" --help`
- look for `chat` and `-q/--quiet` or `status` instead of `--oneshot`.
3. One-shot probe:
- `"<binary>" chat -q "Reply with exactly: OK"`
- Expect exact echoed success text.
4. Auth/model readiness:
- `"<binary>" auth list`
- `"<binary>" model`
- `"<binary>" status`
Regex checks that worked here:
- auth: `Nous Portal ... logged in`
- model: `Model: ...` and `Provider: Nous Portal`

## Windows/MSYS quoting notes
- From Git Bash, wrap absolute paths with spaces in single quotes:
  `'C:\Users\osman\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe'`
- PowerShell fallback uses the same absolute path if needed.

## Why this matters here
In this repo, `scripts/hermes-local-worker.ts` is invoked from a `.cmd`
launcher. A wrong flag does not fail loudly in PowerShell redirection; it just
returns success and never processes queued work. Always validate the exact
worker command path before editing worker code.

## Notes
- Do not assume an upstream README matches this install. Always probe this
machine first.
- If `chat -q` changes in a future CLI release, rerun the help probe before
locking the worker to a new flag.
