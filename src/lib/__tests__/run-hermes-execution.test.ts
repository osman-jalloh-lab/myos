import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  handleBuildIntake: vi.fn(),
  shouldUseExecutionLayer: vi.fn(),
  runHermesExecution: vi.fn(),
  persistExecutedMessage: vi.fn(),
  sendMessage: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  normalizeAgentKey: vi.fn((agent: string | null) => agent),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/chat", () => ({
  chatHistory: vi.fn(),
  channelHistory: vi.fn(),
  persistExecutedMessage: mocks.persistExecutedMessage,
  sendMessage: mocks.sendMessage,
}));

vi.mock("@/lib/build-intake", () => ({
  handleBuildIntake: mocks.handleBuildIntake,
}));

vi.mock("@/lib/hermes-execution/detect-execution-request", () => ({
  shouldUseExecutionLayer: mocks.shouldUseExecutionLayer,
}));

vi.mock("@/lib/hermes-execution/run", () => ({
  runHermesExecution: mocks.runHermesExecution,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));

vi.mock("@/lib/agent-roster", () => ({
  normalizeAgentKey: mocks.normalizeAgentKey,
}));

function chatMessage(role: "user" | "assistant", content: string) {
  return {
    id: `${role}_1`,
    role,
    content,
    channel: "dashboard",
    targetAgent: null,
    createdAt: "2026-07-10T12:00:00.000Z",
  };
}

describe("Hermes execution runner route integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    for (const value of Object.values(mocks)) value.mockClear();
    mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
    mocks.handleBuildIntake.mockResolvedValue({ action: "none" });
    mocks.shouldUseExecutionLayer.mockReturnValue(false);
    mocks.rateLimit.mockReturnValue({ allowed: true });
    mocks.rateLimitResponse.mockReturnValue(new Response("rate limited", { status: 429 }));
    mocks.persistExecutedMessage.mockResolvedValue({
      userMessage: chatMessage("user", "run validation"),
      reply: chatMessage("assistant", "execution complete"),
    });
    mocks.sendMessage.mockResolvedValue({
      userMessage: chatMessage("user", "hello"),
      reply: chatMessage("assistant", "hello back"),
    });
    mocks.runHermesExecution.mockResolvedValue({
      status: "completed",
      answer: "Execution complete.",
      toolCalls: [],
      artifacts: [{ type: "text", title: "Validation", content: "ok" }],
    });
  });

  it("calls the execution runner directly from chat without nested HTTP", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    mocks.shouldUseExecutionLayer.mockReturnValue(true);

    const { POST } = await import("../../app/api/chat/route");
    const res = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "run validation" }),
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.runHermesExecution).toHaveBeenCalledWith("user_1", "run validation", "chat");
    expect(mocks.persistExecutedMessage).toHaveBeenCalledWith("user_1", "run validation", "Execution complete.", "dashboard");
    expect(json.reply).toMatchObject({
      content: "Execution complete.",
      executionStatus: "completed",
      artifacts: [{ type: "text", title: "Validation", content: "ok" }],
      toolCalls: [],
    });
  }, 15_000);

  it("keeps the standalone execute endpoint wired to the same runner", async () => {
    const { POST } = await import("../../app/api/hermes/execute/route");
    const res = await POST(new Request("http://localhost/api/hermes/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "run validation", source: "api", sessionId: "session_1" }),
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runHermesExecution).toHaveBeenCalledWith("user_1", "run validation", "api", {
      sessionId: "session_1",
      context: undefined,
    });
    expect(json).toMatchObject({
      status: "completed",
      answer: "Execution complete.",
      artifacts: [{ type: "text", title: "Validation", content: "ok" }],
    });
  });
});
