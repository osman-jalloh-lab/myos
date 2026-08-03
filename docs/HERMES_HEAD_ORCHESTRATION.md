# Hermes Head Orchestration

Phase 1 defines provider-neutral planning contracts only. Hermes may eventually handle conversational intake, planning, skill selection, delegation recommendations, progress synthesis, and final-response assembly. My OS remains the authority for authentication, permissions, context retrieval, secrets, data classification, cost and time limits, queues, cancellation, audit history, and final authorization.

`OrchestrationEnvelopeV1` records an idempotent request, source, requested outcome, task and data class, bounded context request, candidate skills, approval policy, and limits. `DelegationPlanV1` expresses a proposed disposition, executors, steps, reviewers, and final validation. Neither contract executes a provider, task, skill, or tool.

The canonical executor registry currently names Hermes, Claude, Codex, OpenAI, DeepSeek, and Local. Definitions contain only policy metadata: capabilities, supported task/data classes, write and coding flags, default timeout, and an availability-check reference. They do not contain secrets or adapters. DeepSeek is an optional reviewer, never a mandatory gate.

Policy rejects unknown or disabled executors and skills, invalid timeouts, unbounded or secret-store context, unsupported data/task routing, unauthorized writes, non-coding repository writes, inaccessible skill capabilities, duplicate or circular steps, mandatory reviewer gates, and code/operation plans without final validation. Policy rejection returns structured reason codes.

Skill references are verified against the existing My OS registry through a small adapter. Sources are future-facing: `hermes_os`, `claude_code`, `user`, and `scouted`. This phase neither imports nor executes skills. Context retrieval is also deferred: requests are task-specific, bounded to 50 items, and only permit memory, work knowledge, approved documents, or task history. Full vault and secret-store requests are denied.

Provider-neutral trace vocabulary is exported for future auditing, from `orchestration_received` through `orchestration_completed` or `orchestration_cancelled`. No Fugu terminology is used.

## Read-only My OS planning adapter

`POST /api/orchestration/plan` authenticates with the normal My OS session, derives the user only from that session, and returns a deterministic plan preview. It classifies answer, research, plan, write, code, and review requests without a model call. Code previews recommend Codex and describe future approval and validation requirements; they never queue or run work. Claude is preferred for read-only architecture, research, planning, writing, and review; DeepSeek is an optional review recommendation only.

The response includes a bounded hypothetical context request, matched skill IDs/names/reasons, policy codes and warnings, and `executionStatus: "not_started"`. The route uses a read-only registry view and deterministic score function, so it does not execute skills, create telemetry, create approval or queue records, retrieve Obsidian, write memory, or call any provider. A later phase may replace the deterministic planner with a provider adapter after authorization, auditing, and queue integration. Telegram and Hermes Agent intake remain deferred.

The first pilot should be a read-only My OS chat planning request. Later phases may add Telegram intake and provider adapters for Hermes Agent, Claude, Codex, OpenAI, DeepSeek, and Local only after each adapter is authorized, audited, and integrated with existing approval and execution queues.
