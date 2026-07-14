import type { AgentExecutionInput } from "./task-context";
import type { AcceptanceEvidence, AgentProducedArtifact } from "./task-artifacts";
import type { ApprovalActionType } from "@/lib/approvals";
import { executeArgusLive, executeFuguLive, executePrometheusLive } from "./live-adapters";

export type AgentRuntimeReadiness = {
  ready: boolean;
  reason: string;
};

export type ProposedChildTask = {
  title: string;
  description?: string;
  assignedAgent: string;
  acceptanceCriteria?: string;
  outputContract?: string;
};

export type ProposedApproval = {
  actionType: ApprovalActionType;
  summary: string;
  payload: Record<string, unknown>;
};

export type AgentExecutionResult = {
  status: "completed" | "in_review" | "blocked" | "failed" | "awaiting_approval";
  summary: string;
  artifacts: AgentProducedArtifact[];
  evidence: AcceptanceEvidence[];
  blocker?: {
    type: string;
    reason: string;
    requiredAction?: string;
  };
  followUpTasks?: ProposedChildTask[];
  approvalRequest?: ProposedApproval;
  usage?: {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    costCents?: number;
  };
};

export type AgentCancellationInput = Pick<AgentExecutionInput, "userId" | "projectId" | "projectTaskId" | "executionRunId" | "agentKey">;

export type AgentRuntimeAdapter = {
  agentKey: string;
  canHandle(input: AgentExecutionInput): Promise<AgentRuntimeReadiness>;
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
  cancel?(input: AgentCancellationInput): Promise<void>;
};

function artifact(type: AgentProducedArtifact["type"], title: string, summary: string, content: string, metadata?: Record<string, unknown>): AgentProducedArtifact {
  return { type, title, summary, content, metadata };
}

function evidence(type: string, summary: string, artifactTitle: string, passed = true): AcceptanceEvidence {
  return { type, summary, artifactTitle, passed };
}

function workspaceBlocked(input: AgentExecutionInput): AgentExecutionResult | null {
  if (input.projectContext.workspace.kind !== "missing") return null;
  return {
    status: "blocked",
    summary: "No approved workspace is attached to this task.",
    artifacts: [artifact(
      "completion_report",
      "Workspace setup blocker",
      input.projectContext.workspace.reason,
      `Task "${input.title}" cannot execute code work until a workspace is selected.\n\nRequired action: attach an approved repository, project folder, or isolated sandbox.`
    )],
    evidence: [],
    blocker: {
      type: "workspace_error",
      reason: input.projectContext.workspace.reason,
      requiredAction: "Select or configure an approved workspace.",
    },
  };
}

const projectManagerAdapter: AgentRuntimeAdapter = {
  agentKey: "project-manager",
  async canHandle() {
    return { ready: true, reason: "Project Manager can coordinate planning and workflow state." };
  },
  async execute(input) {
    const content = [
      `Project: ${input.projectContext.name}`,
      `Task: ${input.title}`,
      `Plan: ${input.planId ?? "none"}`,
      `Dependencies completed: ${input.dependencies.length}`,
      `Output contract: ${input.outputContract ?? "none"}`,
    ].join("\n");
    return {
      status: "completed",
      summary: "Project Manager recorded the coordination checkpoint and preserved the accepted plan context.",
      artifacts: [artifact("completion_report", "Project Manager coordination checkpoint", "Plan/task context verified.", content)],
      evidence: [evidence("completion_report", "Project Manager checkpoint artifact recorded.", "Project Manager coordination checkpoint")],
    };
  },
};

const sophosAdapter: AgentRuntimeAdapter = {
  agentKey: "sophos",
  async canHandle() {
    return { ready: true, reason: "Sophos can produce research and capability scouting artifacts." };
  },
  async execute(input) {
    const report = [
      `Research task: ${input.title}`,
      `Project goal: ${input.projectContext.latestInstruction ?? input.projectContext.description ?? input.projectContext.name}`,
      `Accepted plan: ${input.planId ?? "none"}`,
      `Required capabilities: ${input.requiredCapabilities.join(", ") || "none listed"}`,
      `Recommendation: proceed with PM-managed implementation only after workspace and validation gates are clear.`,
    ].join("\n");
    return {
      status: "completed",
      summary: "Sophos produced a scoped research/capability report.",
      artifacts: [artifact("research_report", "Sophos research report", "Scoped research and capability recommendation.", report)],
      evidence: [evidence("research_report", "Research artifact produced with recommendation and capability notes.", "Sophos research report")],
    };
  },
};

const prometheusAdapter: AgentRuntimeAdapter = {
  agentKey: "prometheus",
  async canHandle(input) {
    const blocked = workspaceBlocked(input);
    return blocked
      ? { ready: false, reason: blocked.blocker?.reason ?? "Workspace missing." }
      : { ready: true, reason: `Prometheus can work in ${input.projectContext.workspace.kind}.` };
  },
  async execute(input) {
    const blocked = workspaceBlocked(input);
    if (blocked) return blocked;
    return executePrometheusLive(input);
  },
};

const fuguAdapter: AgentRuntimeAdapter = {
  agentKey: "fugu",
  async canHandle(input) {
    const hasDesignInput = input.previousArtifacts.some((item) => ["code_diff", "build_result", "design_review"].includes(item.type));
    return hasDesignInput
      ? { ready: true, reason: "Design/build artifact exists for review." }
      : { ready: false, reason: "Fugu needs a design or build artifact before review." };
  },
  async execute(input) {
    const hasDesignInput = input.previousArtifacts.some((item) => ["code_diff", "build_result", "design_review"].includes(item.type));
    if (!hasDesignInput) {
      return {
        status: "blocked",
        summary: "No design or build artifact exists for Fugu to review.",
        artifacts: [artifact("design_review", "Fugu review blocker", "Design review is blocked until implementation evidence exists.", "No eligible design/build artifact was found.")],
        evidence: [],
        blocker: { type: "invalid_output", reason: "Design review requires a prior implementation or design artifact." },
      };
    }
    return executeFuguLive(input);
  },
};

const argusAdapter: AgentRuntimeAdapter = {
  agentKey: "argus",
  async canHandle() {
    return { ready: true, reason: "Argus can record validation and readiness evidence." };
  },
  async execute(input) {
    return executeArgusLive(input);
  },
};

const irisAdapter: AgentRuntimeAdapter = {
  agentKey: "iris",
  async canHandle() {
    return { ready: true, reason: "Iris can draft communications behind approval gates." };
  },
  async execute(input) {
    const draft = `Draft for project ${input.projectContext.name}:\n\n${input.description ?? input.title}\n\nThis draft is not sent. External communication requires approval.`;
    return {
      status: "awaiting_approval",
      summary: "Iris prepared a communication draft and queued it for approval.",
      artifacts: [artifact("communication_draft", "Iris communication draft", "Approval-gated draft prepared.", draft)],
      evidence: [evidence("communication_draft", "Communication draft artifact prepared.", "Iris communication draft")],
      approvalRequest: {
        actionType: "draft_email",
        summary: "Approve the communication draft before any external send.",
        payload: { projectId: input.projectId, projectTaskId: input.projectTaskId, draft },
      },
    };
  },
};

const adapters = new Map<string, AgentRuntimeAdapter>([
  [projectManagerAdapter.agentKey, projectManagerAdapter],
  [sophosAdapter.agentKey, sophosAdapter],
  [prometheusAdapter.agentKey, prometheusAdapter],
  [fuguAdapter.agentKey, fuguAdapter],
  [argusAdapter.agentKey, argusAdapter],
  [irisAdapter.agentKey, irisAdapter],
]);

export function getAgentRuntimeAdapter(agentKey: string): AgentRuntimeAdapter | null {
  return adapters.get(agentKey) ?? null;
}

export function registerAgentRuntimeAdapter(adapter: AgentRuntimeAdapter): void {
  adapters.set(adapter.agentKey, adapter);
}

export function listAgentRuntimeAdapters(): AgentRuntimeAdapter[] {
  return [...adapters.values()];
}
