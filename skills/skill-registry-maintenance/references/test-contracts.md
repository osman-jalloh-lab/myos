# Builder Skill Test Contracts

Captured from 2026-07-10 verification pass for the builder skill upgrade.

## taskType expectation matrix

| Input | Canonical taskType |
| --- | --- |
| Build Provider Setup Center. | build |
| Fix the Skills page date bug. | build |
| Start a new pharmacy marketplace project. | project_start |
| My local agent is not functioning. | local_worker_diagnostics |
| Plan the files needed to add Model Council v1. | repo_change |
| Run typecheck, lint, tests, and build. | build_validation |
| Check Vercel deployment. | build_validation |
| Run tests and build. | build_validation |

## Routing name expectations

- build-orchestrator primary name: `Build Orchestrator`
- local-worker-status primary name: `Local Worker Status`

## quality thresholds

- Skills Quality test requires `>= 85`
- Builder skills test requires `>= 90`
