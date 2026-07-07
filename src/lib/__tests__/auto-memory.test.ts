import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryFindMany = vi.fn();
const memoryCreate = vi.fn();
const agentRunCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    memory: {
      findMany: memoryFindMany,
      create: memoryCreate,
    },
    agentRun: {
      create: agentRunCreate,
    },
  },
}));

describe("auto memory capture", () => {
  beforeEach(() => {
    memoryFindMany.mockReset();
    memoryCreate.mockReset();
    agentRunCreate.mockReset();
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
