---
name: nextjs-windows-repo-workflow
title: Next.js Windows Repo Workflow
description: Safe repo-path handling and patch workflow on Windows, especially OneDrive-spaced directories. Use when creating, patching, or verifying files inside a local repo on Windows.
---

platforms: []
version: 0.1.0
license: MIT
# Next.js Windows Repo Workflow

## Trigger
Use this skill when working inside a local Windows repo, particularly when the path contains spaces or OneDrive segments.

## Preferred workflow
1. Confirm the real repo root before editing:
- `pwd`
- `git rev-parse --show-toplevel`
2. Use relative paths from that confirmed root only.
3. Do not rely on absolute paths with spaces; OneDrive paths often expand incorrectly.
4. Stop immediately if any resolved/written path points outside the intended repo.
5. After writing a file, verify it can be read back using the same relative path.

## Repo root discipline
Always run both checks and use paths only after they agree:
```bash
pwd
git rev-parse --show-toplevel
```
Stop if either check fails or points outside the expected repo.

## Path handling
- OneDrive paths often contain spaces. Quote them or use the MSYS-style `/c/Users/...` form explicitly.
- Do not assume `cd` state survives across tool calls implicitly; if chaining, use absolute `workdir` or quote the path in each shell command.

## Pitfalls
- Paths like `C:\\\\Users\\\\osman\\\\OneDrive\\\\Desktop\\\\my dashboard\\\\parawi` may resolve to `C:\\\\c\\\\Users\\\\...` via tool path handling.
- Absolute Windows paths with spaces are not safe for file writes here.
- Continuing after a path mismatch silently corrupts the intended repo state.
- Windows patch/write tooling can diverge from read behavior on OneDrive paths, so a single round-trip verification is required after every file operation.
- OneDrive Windows paths can cause `write_file`/`patch` to report success without the file appearing in the intended repo. Treat success claims on OneDrive repos as provisional until confirmed by `read_file` or `terminal`.
- `write_file` may succeed quietly on MSYS/Cygwin-backed paths but not land inside the target repo tree. After multiple presumed successes with no file appearing, stop file writes and switch to a verified-command procedure before adding more files.
- CLI flags copied from docs/older configs can be invalid on the installed local binary. If a worker, command, or integration “does not run,” inspect the installed binary's `--help` and run a one-shot probe before changing architecture.

## OneDrive Windows write fallback (preferred when writes look ineffective)

Use when `read_file` does not show files after `write_file` claims success, or when persisted bytes disagree with file-tool reads:

```bash
cd_path="C:/Users/osman/OneDrive/Desktop"
target_rel="my os/HERMES_OS_STARTER"
target_abs="$cd_path/$target_rel"
[ -d "$target_abs" ] && cd "$target_abs" || cd_path="$(git rev-parse --show-toplevel 2>/dev/null)"

# Then prefer creating files with explicit `here` heredocs wrapped in a unique sentinel,
# and verify every file with `cat` or `sed -n` immediately after.
```

Rules for this mode:
1. Confirm effective directory from `pwd` first.
2. If `cd` lands outside the intended repo, stop.
3. Prefer explicit absolute Windows paths for OneDrive parent paths only, then `cd` into the project.
4. After every file operation, verify with `cat`/`sed`/`read_file`.
5. If `read_file` and shell reads disagree, treat `patch` state as suspect and use `write_file` for a full-file rewrite from verified source text.

## Verdict-then-fix test workflow

When a user asks for a fix and then approval: do not leave a test-half-fixed state at the end of the session. Complete, verify, and then summarize.
When connecting a local Windows repo to a GitHub remote:
1. List remotes with `git remote -v`. If `origin` exists, stop and ask whether to replace it.
2. Identify the local repo root: `git rev-parse --show-toplevel`.
3. Set a clean HTTPS remote that matches the target repo slug without guessing auth forms.
4. Before pushing, avoid destructive history overwrites:
   - Derive a fresh merge base/rebase from the existing remote default branch.
   - Default to merging history, not resetting or force-pushing.
   - If the default-branch name differs, resolve it from the remote refs instead of assuming `master`.

## Windows Next.js dev-server incident response

Use when a local Next.js app is unreachable on its expected port despite the process apparently running.

Goal: restore serving state with the smallest safe change.

### Triage order

1. Identify the exact owning process for the port. Do not mass-kill Node.
2. Inspect its command line and parent process. Confirm whether it belongs to the intended repo and is actually a Next.js server.
3. Decide before stopping anything:
 - If it is the intended Next.js server from the intended repo, but the port is not serving HTTP correctly → stop only that PID.
 - If it belongs to another app/tool → do not stop it. Use a different port or coordinate with the other owner.
4. For Next.js specifically, clear stale dev artifacts after stopping the dev server and before restart:
 - `.next/dev/lock`
 - `.next/dev` directory contents if present
5. Restart the dev server in foreground on the intended host/port and wait for the explicit readiness line.
6. Verify with the API health endpoint and `/` root HTML.

PowerShell port owner inspection:

```powershell
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $processInfo | Select-Object ProcessId, Name, CommandLine
} else {
  Write-Host "No listener on port 3000"
}
```

Development-mode restart and verification:

```powershell
Stop-Process -Id <pid> -Force
Set-Location "C:\Users\osman\OneDrive\Desktop\my os\hermes-os"
npm run dev -- --hostname 127.0.0.1 --port 3000
```

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/worker/health -TimeoutSec 15
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/ -TimeoutSec 15
```

Production-mode fallback verification on an alternate port:

```powershell
npm run build
npm run start -- -p 3001
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/api/worker/health -TimeoutSec 15
```

Interpretation:
 - dev fails, start works: fix dev-server lifecycle/stale artifacts only.
 - both fail: capture the first meaningful runtime error and fix that exact error.
 - different app owns the port: do not stop it; run Hermes OS on another port.

Support file: `references/windows-nextjs-dev-server-restoration.md`

## Verify installed CLI flags before wiring Windows workers

Use when replacing an invalid local command invocation with the installed binary.

1. Discover the binary:
- `where.exe <command>` or resolve it from a known product install pattern.
- Guard absPath with `existsSync` before use; otherwise fall back to PATH.
2. Validate the invocation surface:
- Run `<binary> --help` and read the exposed subcommands/flags.
- Do not assume docs or prior configs match the installed version.
3. Run a one-shot probe before editing worker code:
- Start with minimal output, e.g. `"<binary>" <subcommand> -q "Reply with exactly: OK"`.
- If exit is non-zero or output does not match, stop and inspect help output.
4. Terminal quoting on Windows/MSYS:
- Quote executable paths with spaces from `bash`.
- Prefer single-quoted paths for PowerShell-assisted calls.
- Avoid bare unquoted `C:\...` paths in POSIX shells.
5. Replace the broken invocation with the verified path/flags instead of adding a second hidden branch.
- Keep the change inspectable in `git diff`; do not add silent fallbacks that make future debugging harder.

## Shielded logging for tokens
Never log or echo the full Telegram bot token from `~/.hermes/.env`. If you need to confirm presence, show presence/absence only.

## References
- `references/onedrive-windows-path-bug.md` captures the failure mode.
- `references/hermes-cli-verification.md` captures the Hermes-specific CLI validation pattern observed on Windows.