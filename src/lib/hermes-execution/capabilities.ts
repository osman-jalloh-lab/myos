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
