export const LOCAL_WORKER_ACTIONS = new Set([
  "prepare",
  "generate",
  "runQa",
  "rebuild",
  "build",
  "npmBuild",
  "startDev",
  "stopDev",
]);

export const SERVER_ONLY_LOCAL_BUILDER_ACTIONS = new Set([
  "fuguGate",
  "fuguDesignReview",
  "fuguGateOverride",
]);

export function isServerOnlyLocalBuilderAction(action: string): boolean {
  return SERVER_ONLY_LOCAL_BUILDER_ACTIONS.has(action);
}

export function assertLocalWorkerQueueAction(action: string): void {
  if (isServerOnlyLocalBuilderAction(action)) {
    throw new Error(`${action} is a server-only action and cannot be queued to the local worker.`);
  }
}

type NonWorkerActionHandlers = {
  complete: (message: string) => Promise<void>;
  fail: (reason: string) => Promise<void>;
  trace: (message: string, severity: "info" | "error") => Promise<void>;
};

export async function settleNonWorkerAction(
  action: string,
  handlers: NonWorkerActionHandlers
): Promise<boolean> {
  if (LOCAL_WORKER_ACTIONS.has(action)) return false;

  if (isServerOnlyLocalBuilderAction(action)) {
    const message = `Skipped server-only action ${action} on local worker (handled server side).`;
    await handlers.trace(message, "info");
    await handlers.complete(message);
    return true;
  }

  const reason = `Worker received unknown action ${action || "(missing)"}.`;
  await handlers.trace(reason, "error");
  await handlers.fail(reason);
  return true;
}
