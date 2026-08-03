export const ORCHESTRATION_SOURCES = ["telegram_text", "telegram_voice", "myos_chat", "automation"] as const;
export const TASK_CLASSES = ["answer", "research", "plan", "write", "code", "operate", "review"] as const;
export const DATA_CLASSES = ["PUBLIC", "PERSONAL", "PRIVATE", "SECRET"] as const;
export const TRACE_EVENTS = ["orchestration_received", "intent_classified", "context_requested", "context_authorized", "skills_matched", "plan_created", "plan_rejected", "approval_requested", "approval_granted", "delegation_started", "delegation_progress", "delegation_completed", "delegation_failed", "validation_started", "validation_completed", "result_synthesized", "orchestration_completed", "orchestration_cancelled"] as const;

export type OrchestrationSource = typeof ORCHESTRATION_SOURCES[number];
export type TaskClass = typeof TASK_CLASSES[number];
export type DataClass = typeof DATA_CLASSES[number];
export type OrchestrationTraceEvent = typeof TRACE_EVENTS[number];
export type ExecutorId = "hermes" | "claude" | "codex" | "openai" | "deepseek" | "local";

export type OrchestrationEnvelopeV1 = {
  version: "1"; idempotencyKey: string; source: OrchestrationSource; userId: string; conversationId: string | null;
  originalMessage: string; requestedOutcome: string; taskClass: TaskClass; dataClass: DataClass;
  contextRequest: { query: string; allowedSources: string[]; maximumItems: number };
  candidateSkillIds: string[]; preferredExecutor: ExecutorId | null;
  approvalPolicy: { requiredBeforeExecution: boolean; allowedOperations: string[] };
  limits: { maxDelegationDepth: number; maxSteps: number; timeoutMs: number; maxEstimatedCostUsd: number | null };
};

export type DelegationStepV1 = { id: string; executor: ExecutorId; purpose: string; capability: string; requiredContext: string[]; expectedOutput: string; requiresApproval: boolean; dependsOn?: string[] };
export type DelegationPlanV1 = {
  version: "1"; disposition: "answer" | "ask" | "delegate" | "approval_required" | "blocked";
  summary: string; skillIds: string[]; primaryExecutor: ExecutorId; reviewerExecutors: ExecutorId[];
  steps: DelegationStepV1[]; finalValidation: string[]; userFacingStatus: string;
};

export type OrchestrationSkill = { id: string; enabled: boolean; source: "hermes_os" | "claude_code" | "user" | "scouted"; safetyClass: "read_only" | "approval_required" | "local_execution"; requiredCapabilities: string[]; allowedTools?: string[] };
export type PolicyReason = { code: string; message: string; path?: string };
export type PolicyResult = { ok: boolean; reasons: PolicyReason[] };
