// Hermes Execution Layer — types
// Additive only. Does not replace any existing Hermes chat/routing logic.
// Activated only when HERMES_EXECUTION_ENABLED=true in env.

export type ExecutionSource = "chat" | "voice" | "api" | "cron";

export type ExecutionRisk = "read" | "internal_write" | "external_write" | "dangerous";

export type ExecutionStatus =
  | "planned"
  | "running"
  | "completed"
  | "approval_required"
  | "blocked"
  | "failed";

export interface ExecutionRequest {
  userId: string;
  sessionId?: string;
  message: string;
  source: ExecutionSource;
  context?: {
    timezone?: string;
    memorySummary?: string;
    availableMcpTools?: string[];
    availableInternalTools?: string[];
    approvalPolicy?: "safe_reads_auto" | "approval_for_external_writes";
  };
}

export interface ExecutionStep {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  risk: ExecutionRisk;
  requiresApproval: boolean;
  dependsOn?: string[];
}

export interface ExecutionPlan {
  intent: string;
  confidence: number;
  steps: ExecutionStep[];
  reasoningSummary?: string;
}

export interface ExecutionToolCall {
  id: string;
  tool: string;
  input?: unknown;
  status: ExecutionStatus;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionArtifact {
  type: "text" | "file" | "link" | "task" | "email_draft" | "calendar_event" | "repo_report";
  title: string;
  url?: string;
  id?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionResponse {
  status: "completed" | "approval_required" | "blocked" | "failed";
  answer: string;
  plan?: ExecutionPlan;
  toolCalls: ExecutionToolCall[];
  artifacts: ExecutionArtifact[];
  approval?: {
    actionType: string;
    summary: string;
    payload: unknown;
  };
}

export interface ToolContext {
  userId: string;
  sessionId?: string;
  source: ExecutionSource;
  previousResults: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ExecutionRisk;
  requiresApproval: boolean;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}
