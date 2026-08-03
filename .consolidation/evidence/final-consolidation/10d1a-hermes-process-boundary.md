# Hermes Process Boundary Map for Restricted Planning

Starting commit: `ccd17a6` on `consolidation/source-of-truth`.

## Baseline

- `npm run lint`: 0 errors, 24 warnings.
- `npm test`: 48 files, 198 tests, all passed.
- `npm run build`: passed. Turbopack emitted 11 instances of the existing `next.config.mjs` “unexpected file in NFT list” category.
- `git diff --check`: passed.
- Protected status: `CLAUDE.md` remains modified and unstaged; `next-env.d.ts` remains unchanged and unstaged.

## Inspected implementation

- `src/lib/hermes-nous-cli.ts`: output credential redaction and chat-output/session parsing only.
- `src/lib/hermes-nous-chat.ts`: persists chat rows and queues `hermes_chat`; unsuitable for planning-only use.
- `scripts/hermes-local-worker.ts`: canonical Hermes discovery, environment filtering, CLI execution, queue/worker integration, tracing, and chat execution.
- `src/lib/execution-queue.ts`: queue persistence used by the existing Hermes chat path.

## Existing call graphs

### Hermes chat

`src/lib/hermes-nous-chat.ts:sendHermesNousMessage`
→ `createExecutionQueueTask(... assignedExecutor: "hermes_chat")`
→ `scripts/hermes-local-worker.ts:claimTask/executeHermesChatTask`
→ discover `hermes-agent` through `where.exe` (`getCapabilities`, lines 503-525)
→ choose sibling `hermes.exe` or `hermes`
→ `execFile(command, ["chat", "-q", message, "--source", "tool", "--max-turns", configured value, optional "--resume", session])` (lines 1086-1126)
→ inherited allowlisted environment (`hermesAgentProcessEnv`, lines 763-773)
→ combined stdout/stderr, 1 MB `maxBuffer`, configured timeout
→ `parseHermesChatOutput`/`sanitizeHermesOutput`
→ persists response and updates queue/task records.

### Hermes build execution

`executeHermesAgentTask` (worker lines 917 onward)
→ build execution prompt and write `HERMES_AGENT_TASK_<id>.md` in a project workspace
→ `execFile(hermes, ["--oneshot", "Read the execution packet ... and execute it completely"])` (lines 968-990)
→ 2 MB output buffer, `HERMES_AGENT_TIMEOUT_MS`, allowlisted environment
→ trace/queue/project updates, then build/install actions.

## Reuse assessment

| Component | Assessment | Evidence |
| --- | --- | --- |
| Command discovery | Reusable after hardening | `where.exe` result and sibling executable discovery are server-side, but live only in the worker. |
| `execFile` process primitive | Reusable after hardening | Avoids a shell for Hermes calls, but does not expose a narrow planning interface. |
| Environment allowlist | Reusable after hardening | Includes broad user profile and app-data variables; a planning wrapper should use a smaller explicit set. |
| Output redaction | Reusable unchanged | `sanitizeHermesOutput` redacts common credential formats, but does not redact local paths. |
| Chat parser | Unsuitable | Parses free-form chat/session output, not one bounded JSON plan. |
| Queue/chat adapter | Unsuitable | Creates queue rows and persists chat messages, violating planning-only side-effect rules. |
| Build/oneshot adapter | Unsuitable | Its instruction explicitly executes workspace tasks and writes a packet file. |
| Timeout/termination | Missing for restricted planning | `execFile` timeout is used, but no explicit Windows process-tree `taskkill`, child `kill`, or abort-signal termination is implemented. |
| Interactive prevention | Missing | Existing chat uses `-q`, but no code proves tools/delegation are disabled or interactive prompts are impossible. |

## Security gaps

The existing process code does not prove tool/delegation disablement, full Windows process-tree termination, abort-signal handling, planning JSON validation, bounded JSON extraction, or local-path redaction. Its worker-facing paths also create queue, trace, chat, project, and workspace side effects. It cannot be used directly for restricted planning.

## Recommendation

**Option B: create a narrow planning-specific wrapper** in a future task. It may reuse trusted executable discovery, `execFile`, safe output redaction, and a reduced environment, but must be independent of queue/worker and build paths. Required additions: fixed planning-only arguments, a restrictive instruction, bounded JSON extraction/validation, explicit output caps, Windows process-tree and abort termination, no inherited secrets, and deterministic fallback.

Real restricted planning is **not currently safe to enable**. Keep deterministic planning as the only active provider.

Expected next-task tests: fixed command/arguments; no shell syntax; env allowlist; timeout and abort kill behavior; malformed/multiple/oversized JSON; policy rejection; no queue/approval/file writes; deterministic fallback; and Telegram reply provider/fallback status.
