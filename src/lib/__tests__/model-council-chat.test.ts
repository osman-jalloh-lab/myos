import { beforeEach, describe, expect, it, vi } from "vitest";

const chatCreateMock = vi.fn();
const chatFindManyMock = vi.fn();
const taskCreateMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: chatCreateMock,
      findMany: chatFindManyMock,
    },
  },
}));

vi.mock("@/lib/execution-queue", () => ({
  createExecutionQueueTask: taskCreateMock,
}));

describe("model council chat queueing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatCreateMock.mockResolvedValue({
      id: "chat-1",
      role: "user",
      content: "review this",
      channel: "dashboard",
      targetAgent: "model_council",
      createdAt: new Date("2026-07-08T16:00:00.000Z"),
    });
    chatFindManyMock.mockResolvedValue([]);
    taskCreateMock.mockResolvedValue({ id: "task-1" });
  });

  it("queues whole-Council questions without a provider selector", async () => {
    const { queueCouncilMessage } = await import("@/lib/model-council-chat");

    const result = await queueCouncilMessage({
      userId: "user-1",
      mode: "council",
      message: "  review this  ",
    });

    expect(chatCreateMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        role: "user",
        content: "review this",
        channel: "dashboard",
        targetAgent: "model_council",
      },
    });
    expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      assignedExecutor: "council_chat",
      priority: "high",
    }));
    const queued = taskCreateMock.mock.calls[0][0] as { description: string };
    expect(JSON.parse(queued.description)).toMatchObject({
      type: "council_chat",
      mode: "council",
      providerFamily: null,
      target: "model_council",
      message: "review this",
      chatMessageId: "chat-1",
    });
    expect(result).toMatchObject({ taskId: "task-1", target: "model_council" });
  });

  it("queues direct provider offices as one-provider requests", async () => {
    chatCreateMock.mockResolvedValueOnce({
      id: "chat-2",
      role: "user",
      content: "challenge this",
      channel: "dashboard",
      targetAgent: "council_ollama",
      createdAt: new Date("2026-07-08T16:05:00.000Z"),
    });
    const { queueCouncilMessage } = await import("@/lib/model-council-chat");

    const result = await queueCouncilMessage({
      userId: "user-1",
      mode: "provider",
      providerFamily: "ollama",
      message: "challenge this",
    });

    const queued = taskCreateMock.mock.calls[0][0] as { description: string };
    expect(JSON.parse(queued.description)).toMatchObject({
      type: "council_chat",
      mode: "provider",
      providerFamily: "ollama",
      target: "council_ollama",
      message: "challenge this",
      chatMessageId: "chat-2",
    });
    expect(result.target).toBe("council_ollama");
  });
});
