# Local Worker Runbook

## This computer

- Source repo: `C:\Users\osman\OneDrive\Desktop\my os\hermes-os`
- Git remote: `https://github.com/osman-jalloh-lab/myos.git`
- Generated projects: `C:\Users\osman\OneDrive\Desktop\HermesProject`
- Worker log: `logs\hermes-local-worker.log` (rotates at 5 MB)

The Local Worker polls Hermes OS, claims queued local build tasks, writes generated projects, runs npm/build/QA commands, starts previews, and publishes a heartbeat.

Hermes Nous is the installed Hermes Agent CLI. It is command-based, not a separate daemon. The Local Worker invokes `hermes --oneshot` for a queued `hermes_agent` task. It requires an installed CLI, Nous login, a selected model/provider, and a running Local Worker. It is not a cloud fallback; work stays queued while this PC or worker is offline.

## Commands

```powershell
Set-Location "C:\Users\osman\OneDrive\Desktop\my os\hermes-os"
npm run worker:start
npm run worker:restart
npm run worker:status
npm run worker:logs
npm run worker:install-startup
npm run nous:status
```

Foreground development remains available with `npm run worker:local`.

Recovery one-liner:

```powershell
Set-Location "C:\Users\osman\OneDrive\Desktop\my os\hermes-os"; powershell -ExecutionPolicy Bypass -File .\scripts\install-hermes-local-worker-startup.ps1; npm run worker:start
```

## Auto-start

The installer attempts to create the Scheduled Task `Hermes Local Worker` with a logon trigger, restart-after-failure, battery operation, and duplicate-instance protection. If Task Scheduler registration fails, it preserves a current-user Startup-folder shortcut fallback.

On this PC, non-elevated task registration returned `Access is denied`; the Startup-folder fallback is installed and verified. To install the Scheduled Task instead, run the installer from an elevated PowerShell window.

## Common fixes

- **Node/npm missing:** Install Node.js LTS, open a new PowerShell window, and verify `node --version` and `npm --version`.
- **Scheduled Task missing:** Run `npm run worker:install-startup`. The Startup-folder fallback remains valid if Windows denies task registration.
- **Worker stale/offline:** Run `npm run worker:restart`, wait 20 seconds, then use `npm run worker:logs`.
- **Hermes Nous missing:** Verify `where.exe hermes-agent` and `where.exe hermes`. This installation lives under `%LOCALAPPDATA%\hermes\hermes-agent`; do not guess a new installer.
- **Hermes Nous needs login/model:** Run `hermes auth`, then `hermes model`, and recheck with `npm run nous:status`.
- **Worker cannot reach Hermes OS:** Verify `https://www.parawi.com/api/worker/health`. Set `HERMES_WORKER_API_BASE_URL` only if the deployment origin changes.
- **Missing configuration:** `.env.local` needs `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Status commands report names only and never print values.

Never paste or commit `.env.local`.
