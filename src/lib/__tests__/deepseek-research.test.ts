import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCouncilProvider: vi.fn(),
  runCouncilProvider: vi.fn(),
}));

vi.mock("@/lib/council-providers", () => ({
  getCouncilProvider: mocks.getCouncilProvider,
  runCouncilProvider: mocks.runCouncilProvider,
}));

const deepseekProvider = {
  family: "deepseek",
  provider: "DeepSeek",
  role: "challenger",
  roleLabel: "Independent Challenger",
  env: ["DEEPSEEK_API_KEY"],
  defaultModel: "deepseek-chat",
  environment: "Both",
  council: true,
  testable: true,
  routePreview: "Public research and drafting.",
};

describe("direct DeepSeek research", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCouncilProvider.mockReturnValue(deepseekProvider);
    mocks.runCouncilProvider.mockResolvedValue({
      family: "deepseek",
      provider: "DeepSeek",
      roleLabel: "Independent Challenger",
      model: "deepseek-chat",
      status: "answered",
      text: "Use a discriminated union for the public API response.",
      safeError: null,
      latencyMs: 12,
    });
  });

  it.each([
    "Review this I-9 work authorization record for employee 123-45-6789.",
    "Use this API_KEY=sk-private-value to draft the client.",
  ])("refuses PRIVATE or SECRET input before resolving or calling DeepSeek", async (message) => {
    const { DEEPSEEK_PRIVATE_REFUSAL, runDeepSeekResearch } = await import("@/lib/deepseek-research");

    await expect(runDeepSeekResearch(message)).rejects.toThrow(DEEPSEEK_PRIVATE_REFUSAL);
    expect(mocks.getCouncilProvider).not.toHaveBeenCalled();
    expect(mocks.runCouncilProvider).not.toHaveBeenCalled();
  });

  it("sends one non-sensitive research prompt to the single DeepSeek provider", async () => {
    const { DEEPSEEK_RESEARCH_SYSTEM_PROMPT, runDeepSeekResearch } = await import("@/lib/deepseek-research");

    const result = await runDeepSeekResearch("Compare two public TypeScript validation strategies.");

    expect(mocks.getCouncilProvider).toHaveBeenCalledOnce();
    expect(mocks.getCouncilProvider).toHaveBeenCalledWith("deepseek");
    expect(mocks.runCouncilProvider).toHaveBeenCalledOnce();
    expect(mocks.runCouncilProvider).toHaveBeenCalledWith(
      deepseekProvider,
      "Compare two public TypeScript validation strategies.",
      { systemPrompt: DEEPSEEK_RESEARCH_SYSTEM_PROMPT }
    );
    expect(DEEPSEEK_RESEARCH_SYSTEM_PROMPT).not.toMatch(/Osman|Hermes OS/i);
    expect(result.answer).toContain("discriminated union");
  });
});
