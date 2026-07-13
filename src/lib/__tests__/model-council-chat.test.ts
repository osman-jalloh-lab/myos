import { beforeEach, describe, expect, it, vi } from "vitest";

const chatCreateMock = vi.fn();
const chatFindManyMock = vi.fn();
const taskCreateMock = vi.fn();
const agentRunCreateMock = vi.fn();
const runCouncilProviderMock = vi.fn();

const providerEntries = [
  { family: "openai", provider: "OpenAI", roleLabel: "Engineering Reviewer", council: true },
  { family: "anthropic", provider: "Anthropic", roleLabel: "Architecture Reviewer", council: true },
  { family: "deepseek", provider: "DeepSeek", roleLabel: "Independent Challenger", council: true },
  { family: "ollama", provider: "Ollama", roleLabel: "Local Private Reviewer", council: true },
  { family: "groq", provider: "Groq", roleLabel: "Domestic Private Reviewer", council: false },
  { family: "gemini", provider: "Gemini", roleLabel: "Strategy Reviewer", council: false },
] as const;

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: chatCreateMock,
      findMany: chatFindManyMock,
    },
    agentRun: { create: agentRunCreateMock },
  },
}));

vi.mock("@/lib/execution-queue", () => ({
  createExecutionQueueTask: taskCreateMock,
}));

vi.mock("@/lib/council-providers", () => ({
  councilProviderEntries: () => providerEntries.filter((entry) => entry.council),
  getProviderOffice: (family: string) => providerEntries.find((entry) => entry.family === family) ?? null,
  runCouncilProvider: runCouncilProviderMock,
  formatCouncilResponse: (mode: string, responses: Array<{ family: string }>) => mode === "council" ? `Council answers: ${responses.map((item) => item.family).join(",")}` : `Provider answer: ${responses[0]?.family}`,
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
    agentRunCreateMock.mockResolvedValue({ id: "run-1" });
    runCouncilProviderMock.mockImplementation(async (entry: { family: string; provider: string; roleLabel: string }) => ({
      family: entry.family,
      provider: entry.provider,
      roleLabel: entry.roleLabel,
      model: "test-model",
      status: "answered",
      text: "Safe answer",
      safeError: null,
      latencyMs: 1,
    }));
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

  it("refuses private or secret data before Council and foreign-office queueing", async () => {
    const { COUNCIL_PRIVATE_REFUSAL, queueCouncilMessage } = await import("@/lib/model-council-chat");

    await expect(queueCouncilMessage({
      userId: "user-1",
      mode: "council",
      message: "Review this I-9 work authorization record for employee 123-45-6789.",
    })).rejects.toThrow(COUNCIL_PRIVATE_REFUSAL);
    await expect(queueCouncilMessage({
      userId: "user-1",
      mode: "provider",
      providerFamily: "deepseek",
      message: "Pasted email body: API_KEY=sk-secret-value",
    })).rejects.toThrow(COUNCIL_PRIVATE_REFUSAL);
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(taskCreateMock).not.toHaveBeenCalled();
  });

  it("refuses private data to foreign offices but allows Groq and Ollama", async () => {
    const { COUNCIL_PRIVATE_REFUSAL, sendCouncilMessage } = await import("@/lib/model-council-chat");
    const privateMessage = "Review this I-9 work authorization record for employee 123-45-6789.";

    for (const providerFamily of ["deepseek", "gemini", "openai", "anthropic"] as const) {
      await expect(sendCouncilMessage({ userId: "user-1", mode: "provider", providerFamily, message: privateMessage }))
        .rejects.toThrow(COUNCIL_PRIVATE_REFUSAL);
    }
    expect(runCouncilProviderMock).not.toHaveBeenCalled();

    for (const providerFamily of ["groq", "ollama"] as const) {
      chatCreateMock
        .mockResolvedValueOnce({ id: `${providerFamily}-user`, role: "user", content: privateMessage, channel: "dashboard", targetAgent: `council_${providerFamily}`, createdAt: new Date("2026-07-12T21:00:00.000Z") })
        .mockResolvedValueOnce({ id: `${providerFamily}-reply`, role: "assistant", content: "Provider answer", channel: "dashboard", targetAgent: `council_${providerFamily}`, createdAt: new Date("2026-07-12T21:00:01.000Z") });
      const result = await sendCouncilMessage({ userId: "user-1", mode: "provider", providerFamily, message: privateMessage });
      expect(result.target).toBe(`council_${providerFamily}`);
    }
    expect(runCouncilProviderMock).toHaveBeenCalledTimes(2);
  });

  it("fans public messages out to every seated Council member", async () => {
    chatCreateMock
      .mockResolvedValueOnce({ id: "public-user", role: "user", content: "Compare two public architecture options.", channel: "dashboard", targetAgent: "model_council", createdAt: new Date("2026-07-12T21:05:00.000Z") })
      .mockResolvedValueOnce({ id: "public-reply", role: "assistant", content: "Council answers", channel: "dashboard", targetAgent: "model_council", createdAt: new Date("2026-07-12T21:05:01.000Z") });
    const { sendCouncilMessage } = await import("@/lib/model-council-chat");

    const result = await sendCouncilMessage({ userId: "user-1", mode: "council", message: "Compare two public architecture options." });

    expect(result.providerResults.map((item) => item.family)).toEqual(["openai", "anthropic", "deepseek", "ollama"]);
    expect(runCouncilProviderMock).toHaveBeenCalledTimes(4);
  });
});
