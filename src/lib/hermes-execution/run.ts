import { execute } from "@/lib/hermes-execution/executor";
import { loadMcpToolsIntoRegistry } from "@/lib/hermes-execution/mcp-adapter";
import { plan } from "@/lib/hermes-execution/planner";
import { formatExecutionResponseForUser } from "@/lib/hermes-execution/response-formatter";
import { ensureRegistryInitialized } from "@/lib/hermes-execution/tool-registry";
import type { ExecutionPlan, ExecutionRequest, ExecutionResponse } from "@/lib/hermes-execution/types";

let registryReady = false;
let registryReadyPromise: Promise<void> | null = null;

async function initRegistry(): Promise<void> {
  if (registryReady) return;
  if (!registryReadyPromise) {
    registryReadyPromise = (async () => {
      await ensureRegistryInitialized();
      await loadMcpToolsIntoRegistry();
      registryReady = true;
    })().catch((error) => {
      registryReadyPromise = null;
      throw error;
    });
  }
  await registryReadyPromise;
}

export async function runHermesExecution(
  userId: string,
  message: string,
  source: ExecutionRequest["source"],
  options: Pick<ExecutionRequest, "sessionId" | "context"> = {},
): Promise<ExecutionResponse> {
  await initRegistry();
  const execReq: ExecutionRequest = {
    userId,
    message: message.trim(),
    source,
    sessionId: options.sessionId,
    context: options.context,
  };
  const execPlan = await plan(execReq);
  const result = await execute(execPlan, execReq);
  return formatExecutionResponseForUser(result);
}

export async function runHermesExecutionPlan(
  userId: string,
  message: string,
  source: ExecutionRequest["source"],
  execPlan: ExecutionPlan,
  options: Pick<ExecutionRequest, "sessionId" | "context"> = {},
): Promise<ExecutionResponse> {
  await initRegistry();
  const execReq: ExecutionRequest = {
    userId,
    message: message.trim(),
    source,
    sessionId: options.sessionId,
    context: options.context,
  };
  const result = await execute(execPlan, execReq);
  return formatExecutionResponseForUser(result);
}
