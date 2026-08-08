# Native Hermes Capabilities for My OS

Date: 2026-08-07
Status: phased implementation plan

## Objective

Adapt useful, MIT-licensed Hermes Agent patterns into My OS without making Hermes Agent, its CLI, gateway, or Telegram bot part of the My OS runtime.

My OS remains the sole control plane and retains authentication, authorization, approvals, execution permissions, secrets, user identity, Telegram, queues, audit logs, cost controls, timeouts, and final execution authority.

## Existing My OS equivalents

| Capability | Existing My OS control point | Assessment |
| --- | --- | --- |
| Skills | `src/lib/skills/registry.ts`, scoring/routing modules, skills API | Strong base; discovery and full instruction loading need consolidation and hardening. |
| Tool registry | `src/lib/hermes-execution/tool-registry.ts` | Functional but minimal; needs metadata, availability, collision, and policy enforcement. |
| Models/providers | `src/lib/modelRouter.ts`, `src/lib/model-provider-registry.ts` | Existing provider selection, data classes, timeout, fallback, usage logging, and cost estimation must remain authoritative. |
| Delegation | `src/lib/orchestration/*`, `src/lib/agents/dispatcher.ts`, `src/lib/tasks.ts` | Plan schemas and policy checks exist; execution is currently limited and some Hermes CLI adapter code is deliberately unavailable. |
| Memory/context | `src/lib/memory.ts`, `src/lib/memory-context.ts`, `src/lib/context-persistence.ts`, `src/lib/auto-memory.ts` | Durable memory and contextual retrieval exist; compression is basic and conversation-specific. |
| Browser/search | `src/lib/browser-qa.ts`, Mercury search tools | Browser QA and domain search exist; no general permissioned browser session abstraction. |
| Filesystem/code | Local builder and local worker | Correct execution boundary exists; serverless code must not gain direct workstation access. |
| MCP | `src/lib/hermes-execution/mcp-adapter.ts`, MCP-facing routes | Adapter is a no-op and existing MCP-related routes are not a native MCP client. |
| Telegram | Existing webhook route | Must remain the only Telegram integration. |

## Conflicts and integration rules

1. Hermes Agent is Python and process-oriented; My OS is TypeScript/Next.js with database-backed policy. Port interfaces and algorithms, not the runtime.
2. Hermes tool dispatch catches errors and dynamically exposes available tools, but My OS must add user authorization, approval, audit, cost, timeout, and queue checks before dispatch.
3. Hermes skills can be nested by category and loaded with linked files; My OS currently scans some roots only one directory deep and stores a truncated preview.
4. Hermes subagents own isolated sessions and terminals. My OS must instead delegate through its executor registry and approved queue/local-worker boundary.
5. Hermes MCP discovery can dynamically replace MCP tools. My OS must namespace external tools, reject collisions by default, and apply the same policy gate as native tools.
6. Hermes browser/computer/filesystem tools assume a trusted host process. My OS must keep these capabilities local-worker-only and approval-gated for writes or interaction.
7. Existing `/api/chat`, Telegram routing, auth, secrets, queues, and approvals remain intact. New capabilities plug into them instead of creating alternate entry points.
8. No production Ollama enablement and no secret-bearing context may reach hosted models.

## Reusable Hermes patterns

The following patterns are suitable for adaptation under the Hermes Agent MIT license:

- recursive category-aware `SKILL.md` discovery;
- metadata-first skill listing with full instructions loaded only when selected;
- safe linked-file loading constrained to the skill directory;
- centralized tool metadata with availability checks and collision rejection;
- named toolsets resolved to concrete tool allowlists;
- bounded delegation plans with depth, concurrency, and dependency validation;
- context compression that protects the current task and recent tail, prunes old tool output, preserves tool-call/result pairing, and avoids compression thrashing;
- dynamic MCP tool discovery with namespacing and refresh;
- provider-neutral message/tool schemas;
- result-size budgets and normalized tool errors.

The Hermes CLI, gateway, credentials, state database, session database, scheduler, and Telegram implementation are not reusable runtime dependencies for My OS.

## Phased implementation

### Subsystem 1: native skill discovery and loading

- Add recursive, category-aware `SKILL.md` discovery for My OS-owned skill roots.
- Preserve existing JSON skill compatibility and deterministic precedence.
- Ignore templates, hidden directories, malformed entries, symlink escapes, and duplicate IDs safely.
- Add a full instruction loader with linked-file path containment and size limits.
- Keep per-user enable/usage state and existing skill scoring unchanged.
- Add focused tests, then run lint, tests, and build.

Acceptance criteria:

- Nested `category/skill/SKILL.md` skills are discoverable without Hermes running.
- Listing reads metadata/previews only; full instructions load on demand.
- `../` traversal and out-of-root symlinks are rejected.
- Existing repository and DB skill precedence remains stable.

### Subsystem 2: policy-aware tool registry and toolsets

- Extend the existing registry with source, toolset, risk, availability, timeout, result budget, and required permission metadata.
- Reject accidental name collisions; require explicit audited overrides.
- Resolve named toolsets into concrete tools.
- Enforce auth, authorization, approval, timeout, audit, and cost checks in one My OS dispatch path.

### Subsystem 3: provider/model abstraction and routing

- Normalize provider capabilities, context windows, tool support, costs, and health.
- Keep My OS data-class restrictions and model-usage logging authoritative.
- Add route decisions for task type, context size, tool requirements, budget, and fallback.
- Do not enable Ollama in production.

### Subsystem 4: context assembly, memory, and compression

- Introduce a bounded context envelope with provenance and data classification.
- Add deterministic pruning before model summarization.
- Protect system policy, current task, approvals, active artifacts, and recent turns.
- Add structured compression summaries and anti-thrashing checks.
- Keep memory writes approval-gated.

### Subsystem 5: delegation execution

- Connect validated delegation plans to My OS executors and queues.
- Enforce depth, concurrency, timeout, budget, cancellation, allowed tools, and context scopes.
- Store trace events and child results in My OS audit/task records.
- Keep final synthesis and execution authority in My OS.

### Subsystem 6: MCP client

- Add a native TypeScript MCP client owned by My OS.
- Support configured stdio/HTTP servers without requiring Hermes.
- Namespace discovered tools and pass them through the My OS registry and policy gate.
- Store server configuration references only; keep secrets in My OS secret management.

### Subsystem 7: search and browser tools

- Register existing Mercury search capabilities through the policy-aware registry.
- Add bounded browser sessions for read-only navigation first.
- Require approval for form submission, downloads with side effects, authentication changes, and external writes.
- Capture browser artifacts and audit events.

### Subsystem 8: filesystem, code, and computer use

- Expose filesystem/code operations only through the local worker sandbox.
- Add workspace roots, path containment, command allowlists, output limits, and approval gates.
- Add computer-use only after browser controls are stable, with screenshots, action limits, and explicit interaction approval.

## Verification and commit discipline

For every subsystem:

1. confirm the repository root, branch, and dirty-tree boundary;
2. modify only subsystem-owned files;
3. run focused tests;
4. run lint, full tests, and production build where applicable;
5. inspect the staged diff for unrelated or line-ending changes;
6. commit only that subsystem;
7. stop and report before starting the next subsystem.

## First implementation boundary

Only Subsystem 1 is authorized by this plan pass. Later subsystems remain unimplemented until Subsystem 1 is verified and reported.
