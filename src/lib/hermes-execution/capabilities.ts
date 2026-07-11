import { ensureRegistryInitialized, listTools } from "./tool-registry";
import type { ExecutionRisk } from "./types";
import { getHermesAgentReadiness, getLocalWorkerLiveness, type HermesAgentReadiness, type WorkerLiveness } from "@/lib/worker-watch";

export type CapabilityTool = {
  name: string;
  description: string;
  risk: ExecutionRisk;
  requiresApproval: boolean;
};

export type CapabilitySnapshot = {
  generatedAt: string;
  tools: CapabilityTool[];
  toolCounts: {
    total: number;
    read: number;
    internalWrite: number;
    externalWrite: number;
    approvalRequired: number;
  };
  worker: WorkerLiveness;
  hermesAgent: HermesAgentReadiness;
  buildExecution: {
    available: boolean;
    executor: "hermes_agent" | "local_worker" | null;
    reason: string;
  };
};

export type CapabilityAnswerShape = "ready_now" | "queue_only" | "needs_setup" | "unsupported";

export type CapabilityAnswer = {
  shape: CapabilityAnswerShape;
  answer: string;
  matchedTools: string[];
  workerStatus: CapabilitySnapshot["worker"]["status"];
};

function buildExecutionStatus(worker: WorkerLiveness, hermesAgent: HermesAgentReadiness): CapabilitySnapshot["buildExecution"] {
  if (worker.status !== "online") {
    return {
      available: false,
      executor: null,
      reason: worker.status === "unknown"
        ? "No local worker heartbeat has been recorded."
        : `Local worker is ${worker.status}.`,
    };
  }

  if (hermesAgent.ready) {
    return {
      available: true,
      executor: "hermes_agent",
      reason: "Local worker is online and Hermes Nous is ready.",
    };
  }

  return {
    available: true,
    executor: "local_worker",
    reason: `Local worker is online; Hermes Nous fallback reason: ${hermesAgent.reason ?? "not ready"}.`,
  };
}

export async function getCapabilitySnapshot(): Promise<CapabilitySnapshot> {
  const [worker, hermesAgent] = await Promise.all([
    getLocalWorkerLiveness(),
    getHermesAgentReadiness(),
    ensureRegistryInitialized(),
  ]).then(([workerResult, hermesAgentResult]) => [workerResult, hermesAgentResult] as const);

  const tools = listTools()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      requiresApproval: tool.requiresApproval,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    tools,
    toolCounts: {
      total: tools.length,
      read: tools.filter((tool) => tool.risk === "read").length,
      internalWrite: tools.filter((tool) => tool.risk === "internal_write").length,
      externalWrite: tools.filter((tool) => tool.risk === "external_write").length,
      approvalRequired: tools.filter((tool) => tool.requiresApproval).length,
    },
    worker,
    hermesAgent,
    buildExecution: buildExecutionStatus(worker, hermesAgent),
  };
}

function hasTool(snapshot: CapabilitySnapshot, pattern: RegExp): boolean {
  return snapshot.tools.some((tool) => pattern.test(tool.name) || pattern.test(tool.description));
}

export function answerCapabilityQuestion(message: string, snapshot: CapabilitySnapshot): CapabilityAnswer {
  const text = message.toLowerCase();
  const wantsBuild = /\b(build|create|make|ship|implement|code|page|app|feature|deploy)\b/.test(text);
  const wantsEmailSend = /\b(send|email|gmail|draft)\b/.test(text);
  const wantsGitHub = /\b(github|repo|pull request|pr|commit)\b/.test(text);
  const wantsCalendar = /\b(calendar|schedule|meeting|event)\b/.test(text);

  const matchedTools = snapshot.tools
    .filter((tool) =>
      (wantsBuild && /build|code|deploy|repo|project/i.test(`${tool.name} ${tool.description}`))
      || (wantsEmailSend && /email|gmail/i.test(`${tool.name} ${tool.description}`))
      || (wantsGitHub && /github|repo|pull request|commit/i.test(`${tool.name} ${tool.description}`))
      || (wantsCalendar && /calendar|event|schedule/i.test(`${tool.name} ${tool.description}`))
    )
    .map((tool) => tool.name)
    .slice(0, 6);

  if (wantsBuild && hasTool(snapshot, /internal\.code\.build|build feature|deployment status|project/i)) {
    if (snapshot.buildExecution.available) {
      const executor = snapshot.buildExecution.executor === "hermes_agent" ? "Hermes Nous through the local worker" : "the local worker";
      return {
        shape: "ready_now",
        answer: `Yes. I can route this through ${executor}. I will still respect approval gates for external writes and production deployment.`,
        matchedTools,
        workerStatus: snapshot.worker.status,
      };
    }
    return {
      shape: "queue_only",
      answer: `I can plan or queue the build, but I cannot honestly say it is building right now because ${snapshot.buildExecution.reason}`,
      matchedTools,
      workerStatus: snapshot.worker.status,
    };
  }

  if ((wantsEmailSend || wantsCalendar || wantsGitHub) && matchedTools.length > 0) {
    const approvalTools = snapshot.tools.filter((tool) => matchedTools.includes(tool.name) && tool.requiresApproval);
    return {
      shape: approvalTools.length ? "needs_setup" : "ready_now",
      answer: approvalTools.length
        ? `I have a matching capability, but it requires approval before any write happens: ${approvalTools.map((tool) => tool.name).join(", ")}.`
        : `I have a matching read capability available: ${matchedTools.join(", ")}.`,
      matchedTools,
      workerStatus: snapshot.worker.status,
    };
  }

  if (matchedTools.length > 0) {
    return {
      shape: "ready_now",
      answer: `I found matching registered tools: ${matchedTools.join(", ")}.`,
      matchedTools,
      workerStatus: snapshot.worker.status,
    };
  }

  return {
    shape: "unsupported",
    answer: "I do not see a registered capability for that yet. I can help plan the integration, but I should not claim it is wired.",
    matchedTools: [],
    workerStatus: snapshot.worker.status,
  };
}
