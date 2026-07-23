# Technical Details

## Hermes CLI Paths and Flags

### Verified Working Command

```bash
'C:\Users\osman\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe' chat -q "<prompt>" --max-turns 40 --source tool --cli -t "<comma-separated tool allowlist>"
```

### Confirmed Valid Flags from `hermes.exe chat --help`

- `-q`, `--query <message>`: one-shot query text
- `--max-turns <n>`: maximum reasoning turns (e.g., `--max-turns 40`)
- `--source <source>`: controls source routing (use `--source tool`)
- `--cli`: enables CLI mode for non-interactive use
- `-t`, `--toolset <toolset>`: restrict available tools (e.g., `-t terminal,file,browser,vision`)

### Confirmed Invalid or Undocumented Flags to Avoid

- `--oneshot`: does NOT exist on current Hermes versions; using it causes silent misbehavior or validation errors.

## Project File Map

`C:\Users\osman\OneDrive\Desktop\my os\hermes-os\`

- `scripts/hermes-local-worker.ts` — Local worker adapter that invokes `hermes.exe chat` with preflight auth/model checks and toolset allowlist.
- `src/app/api/command-center/local-builds/route.ts` — Local builds API; `Prepare` must select `local_worker` to ensure `Project` record creation.
- `src/lib/local-builder.ts` — Build orchestration, QA evaluation, and preview helper functions.
- `src/lib/browser-qa.ts` — Strict local-preview browser QA with Playwright, screenshot artifacts, and mobile viewport checks.
- `src/lib/execution-queue.ts` — Task queueing for Hermes executions.
- `src/app/command-center/BuilderOffice.tsx` — Admin UI for build/queue state and QA status.
- `package.json` — Defines worker scripts: `worker:local`, `worker:start`, `worker:restart`, `worker:status`, `worker:logs`, `worker:install-startup`, `nous:status`.
- `scripts/run-hermes-local-worker.cmd` — CMD runner for the local worker.
- `scripts/install-hermes-local-worker-startup.ps1` — PowerShell installer for Windows startup Task Scheduler task with reliability behaviors.
- `docs/LOCAL_WORKER_RUNBOOK.md` — Operational runbook for local worker management.
- `logs/hermes-local-worker.pid` — Alive PID heartbeat marker created by the worker.
- `artifacts/qa/` — Screenshot and QA artifact output directory; must stay gitignored.

## Environment Notes

- Terminal is bash/MSYS; use POSIX commands, not cmd or PowerShell idioms.
- `.env.local` exists and must not be exposed or rewritten.
- Verify worker readiness via `/api/worker/health` and `worker:status`.
