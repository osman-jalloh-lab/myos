import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const chatCreateMock = vi.fn();
const taskCreateMock = vi.fn();

vi.mock("@libsql/client", () => ({
  createClient: () => ({ execute: executeMock }),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: chatCreateMock,
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/execution-queue", () => ({
  createExecutionQueueTask: taskCreateMock,
}));

describe("Hermes Nous chat queueing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({ rows: [] });
    chatCreateMock.mockResolvedValue({
      id: "chat-1",
      role: "user",
      content: "hello nous",
      channel: "dashboard",
      targetAgent: "hermes_nous",
      createdAt: new Date("2026-07-07T20:00:00.000Z"),
    });
    taskCreateMock.mockResolvedValue({ id: "task-1" });
  });

  it("persists a Hermes Nous user message and queues a hermes_chat worker task", async () => {
    executeMock.mockImplementation((query: string | { sql?: string }) => {
      const sql = typeof query === "string" ? query : query.sql ?? "";
      if (/SELECT hermesSessionId/i.test(sql)) {
        return Promise.resolve({ rows: [{ hermesSessionId: "20260707_155331_4d7f30" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { queueHermesNousMessage } = await import("@/lib/hermes-nous-chat");

    const result = await queueHermesNousMessage("user-1", "  hello nous  ");

    expect(chatCreateMock).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        role: "user",
        content: "hello nous",
        channel: "dashboard",
        targetAgent: "hermes_nous",
      },
    });
    expect(taskCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      assignedExecutor: "hermes_chat",
      priority: "high",
    }));
    const queued = taskCreateMock.mock.calls[0][0] as { description: string };
    expect(JSON.parse(queued.description)).toEqual({
      type: "hermes_chat",
      message: "hello nous",
      chatMessageId: "chat-1",
      hermesSessionId: "20260707_155331_4d7f30",
    });
    expect(result).toMatchObject({
      taskId: "task-1",
      hermesSessionId: "20260707_155331_4d7f30",
      userMessage: { id: "chat-1", targetAgent: "hermes_nous" },
    });
  });
});
