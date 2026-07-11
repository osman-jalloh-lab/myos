import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  chatCreate: vi.fn(),
  transaction: vi.fn(),
  routeMessage: vi.fn(),
  routeToAgent: vi.fn(),
  handleMercuryRequest: vi.fn(),
  autoCaptureUserMemory: vi.fn(),
  logAutoMemoryFailure: vi.fn(),
  buildContextBlock: vi.fn(),
  updateSessionAfterResponse: vi.fn(),
  resolveMessageWithContext: vi.fn(),
  contextStateFromContextBlock: vi.fn(),
  createExecutionRun: vi.fn(),
  appendExecutionEvent: vi.fn(),
  resolveRelevantSkills: vi.fn(),
  recordSkillUsageTelemetry: vi.fn(),
  skillInstructionBlock: vi.fn(),
  formatSkillsUsed: vi.fn(),
  retrieveMemoryForPrompt: vi.fn(),
}));

vi.mock("next/server", () => ({
  after: mocks.after,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: mocks.chatCreate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/agents/hermes", () => ({
  routeMessage: mocks.routeMessage,
  routeToAgent: mocks.routeToAgent,
}));

vi.mock("@/agents/mercury", () => ({
  handleMercuryRequest: mocks.handleMercuryRequest,
}));

vi.mock("@/lib/auto-memory", () => ({
  autoCaptureUserMemory: mocks.autoCaptureUserMemory,
  logAutoMemoryFailure: mocks.logAutoMemoryFailure,
  rememberedTag: (saved: string[]) => saved.length ? `Remembered: ${saved.join(" / ")}` : null,
}));

vi.mock("@/lib/memory-context", () => ({
  buildContextBlock: mocks.buildContextBlock,
  updateSessionAfterResponse: mocks.updateSessionAfterResponse,
}));

vi.mock("@/lib/context-persistence", () => ({
  contextStateFromContextBlock: mocks.contextStateFromContextBlock,
  resolveMessageWithContext: mocks.resolveMessageWithContext,
}));

vi.mock("@/lib/agent-roster", () => ({
  normalizeAgentKey: (agent: string | null) => agent,
}));

vi.mock("@/lib/model-council-chat", () => ({
  isCouncilProviderTarget: () => false,
  providerFamilyFromCouncilTarget: () => null,
  sendCouncilMessage: vi.fn(),
}));

vi.mock("@/lib/execution-runs", () => ({
  createExecutionRun: mocks.createExecutionRun,
  appendExecutionEvent: mocks.appendExecutionEvent,
}));

vi.mock("@/lib/skills/routing", () => ({
  resolveRelevantSkills: mocks.resolveRelevantSkills,
  recordSkillUsageTelemetry: mocks.recordSkillUsageTelemetry,
  skillInstructionBlock: mocks.skillInstructionBlock,
  formatSkillsUsed: mocks.formatSkillsUsed,
}));

vi.mock("@/lib/memory-center", () => ({
  retrieveMemoryForPrompt: mocks.retrieveMemoryForPrompt,
}));

const baseSkillResolution = {
  matched: false,
  agentName: "hermes",
  projectId: null,
  taskType: "general",
  confidence: 0,
  reason: "none",
  skills: [],
  consideredSkillCount: 0,
  primarySkill: null,
  supportingSkills: [],
  rejectedSkills: [],
  qualityWarnings: [],
  missingContextQuestions: [],
  explanation: "none",
};

function chatRow(role: "user" | "assistant", content: string) {
  return {
    id: `${role}_${Math.random().toString(36).slice(2)}`,
    role,
    content,
    channel: "dashboard",
    targetAgent: null,
    createdAt: new Date("2026-07-10T12:00:00Z"),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("chat auto-memory scheduling", () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockReset();
    mocks.after.mockImplementation(() => undefined);
    mocks.chatCreate.mockImplementation(async ({ data }: { data: { role: "user" | "assistant"; content: string } }) =>
      chatRow(data.role, data.content)
    );
    mocks.transaction.mockImplementation(async (operations: Array<Promise<unknown>>) => Promise.all(operations));
    mocks.buildContextBlock.mockResolvedValue("");
    mocks.contextStateFromContextBlock.mockReturnValue({});
    mocks.resolveMessageWithContext.mockImplementation((message: string) => ({ resolvedText: message }));
    mocks.resolveRelevantSkills.mockResolvedValue(baseSkillResolution);
    mocks.createExecutionRun.mockResolvedValue(null);
    mocks.retrieveMemoryForPrompt.mockResolvedValue(null);
    mocks.skillInstructionBlock.mockReturnValue(null);
    mocks.formatSkillsUsed.mockReturnValue("Skills used: none matched.");
    mocks.recordSkillUsageTelemetry.mockResolvedValue(undefined);
    mocks.updateSessionAfterResponse.mockResolvedValue(undefined);
    mocks.routeMessage.mockResolvedValue({ reply: "assistant reply", pendingApprovals: [] });
  });

  it("does not wait for auto-memory before routing and replying", async () => {
    const { sendMessage } = await import("../chat");
    let resolveMemory!: (value: string[]) => void;
    mocks.autoCaptureUserMemory.mockReturnValue(new Promise<string[]>((resolve) => {
      resolveMemory = resolve;
    }));

    const pending = sendMessage("user_1", "Morning focus blocks work best for me when planning deep work.");
    await flushPromises();
    await vi.waitFor(() => expect(mocks.routeMessage).toHaveBeenCalled(), { timeout: 250 });
    expect(mocks.autoCaptureUserMemory).toHaveBeenCalled();

    const result = await pending;
    expect(result.reply.content).not.toContain("Remembered:");
    expect(mocks.after).toHaveBeenCalledTimes(1);

    resolveMemory(["Suggested memory: User prefers morning focus blocks"]);
    await mocks.after.mock.calls[0][0]();
  });

  it("keeps the remembered tag when auto-memory finishes within the grace window", async () => {
    const { sendMessage } = await import("../chat");
    mocks.autoCaptureUserMemory.mockResolvedValue(["my preferred meeting window is after 2pm"]);

    const result = await sendMessage("user_1", "remember that my preferred meeting window is after 2pm");

    expect(result.reply.content).toContain("Remembered: my preferred meeting window is after 2pm");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("moves executed-message auto-memory entirely into after()", async () => {
    const { persistExecutedMessage } = await import("../chat");
    mocks.autoCaptureUserMemory.mockResolvedValue(["my desk is in the east room"]);

    const result = await persistExecutedMessage("user_1", "remember that my desk is in the east room", "done");

    expect(result.reply.content).toBe("done");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.autoCaptureUserMemory).not.toHaveBeenCalled();

    await mocks.after.mock.calls[0][0]();
    expect(mocks.autoCaptureUserMemory).toHaveBeenCalledWith("user_1", "remember that my desk is in the east room");
  });
});
