# Nous Hermes Agent Coding Executor

Parawi remains the orchestrator and Mission Control remains the queue/UI. The Local Worker watches tasks and launches Nous Research Hermes Agent only when `assigned_executor = hermes_agent`. Local Builder remains the default until a Hermes Agent test completes successfully.

## Install

Hermes Agent is already installed on the current Windows machine. On another native Windows worker, use the official PowerShell installer:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Confirm `Get-Command hermes-agent` resolves, then finish the Hermes provider setup before unattended use.

## Run

Set `HERMES_WORKER_API_BASE_URL` to the deployed Parawi URL (or localhost for local development), then run:

```powershell
npm run worker:local
```

In Builder Office, prepare a build, choose **Hermes Agent** under **Build with**, and generate. Local Builder remains selected by default.

## Parawi Local App Contract

Unless the user explicitly requests another framework, Hermes Agent must produce a Next.js App Router application using TypeScript. Every generated app must include:

- `src/app/page.tsx`
- `src/app/layout.tsx`
- `src/app/globals.css`
- `package.json` dependencies on `next`, `react`, and `react-dom`
- a `build` script equal to `next build`

Vite, Create React App, root `index.html`, plain-HTML scaffolds, and unsupported framework files are rejected by the Local Worker. After Hermes exits, the worker verifies the contract before installing dependencies or building. A violation fails the queue task with `Wrong framework: expected Next.js App Router.` Parawi then runs `npm run build` and the existing Local Builder QA checklist.

## Safety boundary

The worker rejects paths outside a child folder of `HERMES_LOCAL_PROJECTS_ROOT`, rejects the Parawi repository, strips Parawi/API secrets from the child process environment, disables automatic Git/push behavior in the execution packet, checks for deleted folders, and removes the temporary prompt file after execution. Hermes Agent receives an explicit prohibition on reading or editing `.env` files. For a hard OS-level read sandbox, run the worker under a dedicated Windows account or container that cannot read secret-bearing files.
