# Hermes OS Feature Provenance Matrix

**Status:** Active consolidation control document  
**Owner:** Osman Jalloh  
**Canonical branch:** `consolidation/source-of-truth`  
**Canonical tree:** `C:\Users\osman\OneDrive\Desktop\my os\hermes-os`  
**Last verified recovery commit:** `a33cbf5`

## Rules

Variants are read-only evidence sources. Never merge a variant or its branch wholesale. Each capability needs a behavior contract, provenance, and tests before an approved port. `CLAUDE.md` and `next-env.d.ts` are protected user edits and are excluded from consolidation commits.

| Feature | Reported source | Canonical status | Evidence state | Decision |
| --- | --- | --- | --- | --- |
| Obsidian execution | local `hermes-os` | Present but unreachable/incomplete | CHARACTERIZED | Preserve as historical canonical code; reimplement only with approval |
| DeepSeek council | `hermes-os-deepseek-council` | Not verified | UNREVIEWED | TBD |
| DeepSeek direct | `hermes-os-deepseek-direct` | Not verified | UNREVIEWED | TBD |
| Skill upgrades | `hermes-os-skill-upgrade` | Not verified | UNREVIEWED | Review one subsystem at a time |
| Fugu/Sakana gate | Canonical tree and historical variant | Removed from active source and current schema | RETIRED | Preserve historical migration/evidence only; do not import from variants |
| Dynamic cron buckets | Canonical tree | Operational by design | CANONICAL | Preserve |
| p5js ESM exporter | Canonical branch | Validated at `15be539` | CANONICAL | Preserve |

## Obsidian execution provenance record

### Evidence

Evidence was captured at `.consolidation/evidence/obsidian/` on `a33cbf5676b8b9df8b8207398749ab68e92ddb51`.

| File | SHA-256 | First/only history entry |
| --- | --- | --- |
| `src/lib/obsidian-worker-task.ts` | `F3A3D4E8BEAD1E03C7E2A68E3DB7040D8D9EE2991386450465F2844B16826FCC` | `ed2b1a3` — 2026-07-22, Osman Jalloh, “Add skills registry and Obsidian integration” |
| `src/lib/hermes-execution/tools/obsidian-tools.ts` | `2FA38EE3B301FBA37FBAB2CF0E8C49E824EC1DDEB7BC967C24DE7EF50656B97B` | `ed2b1a3` — 2026-07-22, Osman Jalloh, “Add skills registry and Obsidian integration” |

Both files exist only in the large local tree; the six frozen variants do not contain them. No deployment evidence was found in the inspected code/history.

### Verified call graph

```text
Declared tool definitions
  -> registerObsidianTools() in obsidian-tools.ts
  -> no caller/import from registerInternalTools() or another initialization path
  -> no planner-visible tool registration

If invoked directly (not reachable through normal execution)
  -> createExecutionQueueTask(... assignedExecutor: "obsidian_worker")
  -> local worker claims the task
  -> generic executeLocalWorkerTask() parses an action/message payload
  -> no obsidian_worker branch or vault/filesystem implementation exists
```

The approved-write path has the same terminal gap: `createApproval(..., "obsidian_write_note")` queues an `obsidian_worker` task when approved, but the worker has no handler for that executor or its operation payload.

### Behavior contract: current implementation

| Area | Verified behavior |
| --- | --- |
| Declared tools | `obsidian.listNotes`, `obsidian.readNote`, `obsidian.searchNotes`, and `obsidian.writeNote` |
| Declared reads | Queue a task only; no note list, read, or search code exists |
| Declared write | Creates an `obsidian_write_note` approval action; approval queues a task only |
| Registration | Missing. `ensureRegistryInitialized()` calls `registerInternalTools()` only; it never calls `registerObsidianTools()` |
| User/API trigger | None found |
| Worker task | `assignedExecutor: "obsidian_worker"`; no corresponding local-worker dispatch branch |
| Authentication | Not independently provable because no normal trigger exists |
| Approval | Declared and implemented for write requests only; reads declare no approval |
| Vault path/configuration | No runtime vault configuration or filesystem implementation exists in the inspected files |
| Persistence/status | The generic `AgentTask` queue and `ApprovalAction` are used; no successful Obsidian result path exists |
| Tests | No Obsidian-specific tests found |

### Security characterization

The current code does not cross the filesystem boundary because it does not implement vault operations. It therefore cannot satisfy the required containment, symlink/junction, secret-exclusion, bounded-size, audit-redaction, or worker-timeout behavior. These controls must be designed and tested before any feature is made reachable.

Mandatory future tests include a temporary vault, valid-path behavior, traversal and absolute/UNC-path rejection, symlink escape rejection where supported, `.env` exclusion, bounded payloads, approval enforcement, idempotent retry behavior, audit records, and worker-level terminal failure handling.

### Decision gate

| Gate | Result | Evidence |
| --- | --- | --- |
| Both reported files exist | Pass | Evidence hashes and Git history |
| Real trigger and registration path exists | Fail | No `registerObsidianTools()` caller |
| Worker performs vault operation | Fail | No `obsidian_worker` dispatch or filesystem code |
| Vault boundary is enforced | Fail | No vault implementation or tests |
| Write approval policy is declared | Partial | `obsidian_write_note` approval is created before queueing |
| Characterization tests pass | Fail | No feature tests exist |
| Repository validation | Pass | Recovery validation: lint 0 errors, 161 tests passed, production build passed |

**Provisional decision:** preserve the two files as evidence of an unfinished canonical integration. Do not expose, port, or expand them. A future, separately approved implementation must be a bounded local-worker capability with explicit vault configuration, containment controls, approval enforcement, and characterization tests.

## Fugu/Sakana retirement

Fugu/Sakana has been removed from canonical active source, runtime, configuration, worker execution, API, UI, health reporting, prompts, templates, tests, and the current Prisma schema. Historical migrations and consolidation evidence remain for provenance only. See `docs/FUGU_SCHEMA_REMOVAL.md` for the tested forward migration and production preflight.
