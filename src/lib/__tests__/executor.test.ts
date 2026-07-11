import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionPlan, ExecutionRequest } from "@/lib/hermes-execution/types";

const mocks = vi.hoisted(() => ({
  agentRunCreate: vi.fn(),
  createExecutionQueueTask: vi.fn(),
  updateExecutionQueueTask: vi.fn(),
  getTool: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: {
      create: mocks.agentRunCreate,
    },
  },
}));

vi.mock("@/lib/execution-queue", () => ({
  createExecutionQueueTask: mocks.createExecutionQueueTask,
  updateExecutionQueueTask: mocks.updateExecutionQueueTask,
}));

vi.mock("@/lib/hermes-execution/tool-registry", () => ({
  getTool: mocks.getTool,
}));

const req: ExecutionRequest = {
  userId: "user_1",
  message: "run validation",
  source: "chat",
};

const plan: ExecutionPlan = {
  intent: "run_command",
  confidence: 1,
  steps: [{
    id: "step_1",
    tool: "internal.test",
    input: { message: "run validation" },
    risk: "read",
    requiresApproval: false,
  }],
};

describe("Hermes execution executor", () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockReset();
    mocks.createExecutionQueueTask.mockResolvedValue({ id: "queue_1" });
    mocks.updateExecutionQueueTask.mockResolvedValue({ id: "queue_1" });
    mocks.agentRunCreate.mockResolvedValue({});
    mocks.getTool.mockReturnValue({
      name: "internal.test",
      description: "test tool",
      risk: "read",
      requiresApproval: false,
      execute: vi.fn(async () => ({ answer: "validated" })),
    });
  });

  it("starts per-step queue updates without waiting for the agent-run log insert", async () => {
    let resolveLog!: () => void;
    let completedUpdateStarted = false;
    mocks.agentRunCreate.mockImplementation(() => new Promise<void>((resolve) => {
      resolveLog = resolve;
    }));
    mocks.updateExecutionQueueTask.mockImplementation(async (_userId: string, _taskId: string, updates: { log?: string }) => {
      if (updates.log === "Completed internal.test.") completedUpdateStarted = true;
      return { id: "queue_1" };
    });

    const { execute } = await import("@/lib/hermes-execution/executor");
    const pending = execute(plan, req);

    await vi.waitFor(() => expect(mocks.agentRunCreate).toHaveBeenCalledTimes(1));
    expect(completedUpdateStarted).toBe(true);

    resolveLog();
    const result = await pending;

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("validated");
    expect(mocks.updateExecutionQueueTask.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      expect.objectContaining({ status: "planning", log: 'Plan created for intent "run_command" with 1 step(s).' }),
      expect.objectContaining({ status: "executing", log: "Execution started." }),
      expect.objectContaining({ status: "executing", log: "Running internal.test." }),
      expect.objectContaining({ status: "executing", log: "Completed internal.test." }),
      expect.objectContaining({ status: "completed", log: "Execution completed." }),
    ]);
  });
});
