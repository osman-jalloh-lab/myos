import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryFindMany = vi.fn();
const memoryCreate = vi.fn();
const agentRunCreate = vi.fn();
const approvalFindMany = vi.fn();
const approvalFindFirst = vi.fn();
const approvalCreate = vi.fn();
const callModel = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    memory: {
      findMany: memoryFindMany,
      create: memoryCreate,
    },
    agentRun: {
      create: agentRunCreate,
    },
    approvalAction: {
      findMany: approvalFindMany,
      findFirst: approvalFindFirst,
      create: approvalCreate,
    },
  },
}));

vi.mock("@/lib/modelRouter", () => ({
  callModel,
}));

describe("auto memory capture", () => {
  beforeEach(() => {
    memoryFindMany.mockReset();
    memoryCreate.mockReset();
    agentRunCreate.mockReset();
    approvalFindMany.mockReset();
    approvalFindFirst.mockReset();
    approvalCreate.mockReset();
    callModel.mockReset();
  });

  it("saves explicit facts through the approved memory path", async () => {
    const { autoCaptureUserMemory } = await import("../auto-memory");
    memoryFindMany.mockResolvedValue([]);
    memoryCreate.mockResolvedValue({});

    const saved = await autoCaptureUserMemory("user_1", "remember that my preferred meeting window is after 2pm");

    expect(saved).toEqual(["my preferred meeting window is after 2pm"]);
    expect(memoryCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user_1",
        fact: "my preferred meeting window is after 2pm",
        source: "auto-memory:user-stated",
      }),
    }));
  });

  it("queues inferred facts for approval instead of saving them permanently", async () => {
    const { autoCaptureUserMemory } = await import("../auto-memory");
    memoryFindMany.mockResolvedValue([]);
    approvalFindMany.mockResolvedValue([]);
    approvalFindFirst.mockResolvedValue(null);
    approvalCreate.mockResolvedValue({
      id: "approval_1",
      userId: "user_1",
      actionType: "save_memory",
      payload: JSON.stringify({ fact: "User prefers morning focus blocks", source: "auto-memory:llm-inferred", confidence: 70, inferred: true }),
      status: "pending",
      createdAt: new Date("2026-07-09T10:00:00Z"),
      resolvedAt: null,
    });
    callModel.mockResolvedValue({ text: JSON.stringify(["User prefers morning focus blocks"]) });

    const saved = await autoCaptureUserMemory("user_1", "Morning focus blocks work best for me when planning deep work.");

    expect(saved).toEqual(["Suggested memory: User prefers morning focus blocks"]);
    expect(memoryCreate).not.toHaveBeenCalled();
    expect(approvalCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user_1",
        actionType: "save_memory",
      }),
    }));
    const payload = JSON.parse(approvalCreate.mock.calls[0][0].data.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      fact: "User prefers morning focus blocks",
      source: "auto-memory:llm-inferred",
      confidence: 70,
      inferred: true,
    });
  });

  it("logs capture failures instead of swallowing them invisibly", async () => {
    const { autoCaptureUserMemory, logAutoMemoryFailure } = await import("../auto-memory");
    const error = new Error("database unavailable");
    memoryFindMany.mockRejectedValue(error);
    agentRunCreate.mockResolvedValue({});

    await expect(autoCaptureUserMemory("user_1", "remember that my desk is in the east room")).rejects.toThrow("database unavailable");
    await logAutoMemoryFailure("user_1", "remember that my desk is in the east room", error);

    expect(agentRunCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentName: "mnemosyne",
        modelProvider: "auto-memory",
        status: "failed",
        outputSummary: "database unavailable",
      }),
    }));
  });
});
