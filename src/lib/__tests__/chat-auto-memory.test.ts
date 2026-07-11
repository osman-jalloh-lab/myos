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
  inferAgent: vi.fn(),
  taskTypeFor: vi.fn(),
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

vi.mock("@/lib/skills/scoring", () => ({
  inferAgent: mocks.inferAgent,
  taskTypeFor: mocks.taskTypeFor,
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
    mocks.inferAgent.mockReturnValue("hermes");
    mocks.taskTypeFor.mockReturnValue("general");
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
    expect(mocks.after).toHaveBeenCalledTimes(3);
    expect(mocks.recordSkillUsageTelemetry).not.toHaveBeenCalled();
    expect(mocks.updateSessionAfterResponse).not.toHaveBeenCalled();

    resolveMemory(["Suggested memory: User prefers morning focus blocks"]);
    await Promise.all(mocks.after.mock.calls.map(([callback]) => callback()));
    expect(mocks.recordSkillUsageTelemetry).toHaveBeenCalled();
    expect(mocks.updateSessionAfterResponse).toHaveBeenCalled();
  });

  it("keeps the remembered tag when auto-memory finishes within the grace window", async () => {
    const { sendMessage } = await import("../chat");
    mocks.autoCaptureUserMemory.mockResolvedValue(["my preferred meeting window is after 2pm"]);

    const result = await sendMessage("user_1", "remember that my preferred meeting window is after 2pm");

    expect(result.reply.content).toContain("Remembered: my preferred meeting window is after 2pm");
    expect(mocks.after).toHaveBeenCalledTimes(2);
    expect(mocks.recordSkillUsageTelemetry).not.toHaveBeenCalled();

    await Promise.all(mocks.after.mock.calls.map(([callback]) => callback()));
    expect(mocks.recordSkillUsageTelemetry).toHaveBeenCalled();
    expect(mocks.updateSessionAfterResponse).toHaveBeenCalled();
  });

  it("pre-generates a run id for parallel memory retrieval without changing the routed prompt", async () => {
    const { sendMessage } = await import("../chat");
    const skillResolution = {
      ...baseSkillResolution,
      matched: true,
      agentName: "athena",
      projectId: "project_1",
      taskType: "grc-risk-role-screener",
      confidence: 87,
      reason: "GRC role scoring matched.",
    };
    const memoryRetrieval = {
      confirmedFacts: [{ id: "mem_1", fact: "Use the GRC scorecard.", source: "memory", confidence: 93 }],
      projectDecisions: [],
      redactedCount: 0,
    };

    mocks.autoCaptureUserMemory.mockResolvedValue([]);
    mocks.resolveMessageWithContext.mockReturnValue({ resolvedText: "Score this GRC internship for me.", projectId: "project_1" });
    mocks.inferAgent.mockReturnValue("athena");
    mocks.taskTypeFor.mockReturnValue("grc-risk-role-screener");
    mocks.resolveRelevantSkills.mockResolvedValue(skillResolution);
    mocks.createExecutionRun.mockImplementation(async ({ id }: { id: string }) => ({ id }));
    mocks.retrieveMemoryForPrompt.mockResolvedValue(memoryRetrieval);
    mocks.skillInstructionBlock.mockReturnValue("SKILL BLOCK");

    await sendMessage("user_1", "Score this GRC internship for me.");

    const createdRunId = mocks.createExecutionRun.mock.calls[0][0].id;
    expect(createdRunId).toEqual(expect.any(String));
    expect(mocks.retrieveMemoryForPrompt).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "athena",
      taskType: "grc-risk-role-screener",
      projectId: "project_1",
      runId: createdRunId,
    }));
    expect(mocks.resolveRelevantSkills).toHaveBeenCalledWith(expect.objectContaining({
      message: "Score this GRC internship for me.",
      projectId: "project_1",
      maxSkills: 3,
    }));
    expect(mocks.appendExecutionEvent).toHaveBeenCalledWith(createdRunId, expect.objectContaining({
      phase: "planning",
      message: "Memory retrieved: 1 confirmed facts, 0 project decisions.",
    }));
    expect(mocks.appendExecutionEvent.mock.invocationCallOrder[0]).toBeLessThan(mocks.routeMessage.mock.invocationCallOrder[0]);
    expect(mocks.routeMessage).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("RETRIEVED CONFIRMED MEMORY\n- Use the GRC scorecard. (source: memory, confidence: 93%)\n\nSKILL BLOCK\n\nUSER MESSAGE\nScore this GRC internship for me."),
      "dashboard",
      undefined,
    );

    await Promise.all(mocks.after.mock.calls.map(([callback]) => callback()));
    expect(mocks.appendExecutionEvent).toHaveBeenCalledWith(createdRunId, expect.objectContaining({
      phase: "completed",
      status: "completed",
    }));
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
