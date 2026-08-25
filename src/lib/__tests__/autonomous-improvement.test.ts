import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createApproval: vi.fn(), createExecutionRun: vi.fn(), appendExecutionEvent: vi.fn(), resolveRelevantSkills: vi.fn(), runCouncilProvider: vi.fn() }));
vi.mock("@/lib/approvals", () => ({ createApproval: mocks.createApproval }));
vi.mock("@/lib/execution-runs", () => ({ createExecutionRun: mocks.createExecutionRun, appendExecutionEvent: mocks.appendExecutionEvent }));
vi.mock("@/lib/skills/routing", () => ({ resolveRelevantSkills: mocks.resolveRelevantSkills }));
vi.mock("@/lib/council-providers", () => ({
  councilProviderEntries: () => [
    { family: "openai", provider: "OpenAI", roleLabel: "Engineering" },
    { family: "anthropic", provider: "Anthropic", roleLabel: "Architecture" },
    { family: "deepseek", provider: "DeepSeek", roleLabel: "Challenger" },
    { family: "ollama", provider: "Ollama", roleLabel: "Local" },
  ],
  runCouncilProvider: mocks.runCouncilProvider,
}));

import { buildImprovementPlan, isSelfImprovementIntent, prepareSelfImprovement } from "@/lib/autonomous-improvement";
import { selectDynamicCouncil } from "@/lib/dynamic-council";

describe("approval-gated My OS improvement planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createExecutionRun.mockResolvedValue({ id: "run-1" });
    mocks.appendExecutionEvent.mockResolvedValue({});
    mocks.resolveRelevantSkills.mockResolvedValue({ skills: [{ id: "frontend-design" }] });
    mocks.runCouncilProvider.mockImplementation(async (entry: { family: string; provider: string; roleLabel: string }) => ({ ...entry, model: "test", status: "answered", text: "Recommendation: extend the existing path.", safeError: null, latencyMs: 1 }));
    mocks.createApproval.mockResolvedValue({ id: "approval-1", actionType: "engineering_plan", status: "pending" });
  });
  it("recognizes My OS changes but not ordinary questions", () => {
    expect(isSelfImprovementIntent("Add voice chat to My OS")).toBe(true);
    expect(isSelfImprovementIntent("What is the weather today?")).toBe(false);
  });

  it("produces a protected registered-workspace plan that excludes merge deploy and push", () => {
    const objective = "Add a harmless small UI enhancement to My OS";
    const plan = buildImprovementPlan(objective, selectDynamicCouncil(objective), []);
    expect(plan.affectedWorkspace).toMatchObject({ id: "my-os", protected: true, registered: true });
    expect(plan.approvalScope).toMatch(/implementation and validation/i);
    expect(plan.excludedActions).toEqual(expect.arrayContaining(["merge", "deployment", "push"]));
  });

  it("stops at awaiting approval and delegates nothing before approval", async () => {
    const result = await prepareSelfImprovement("user-1", "Add voice chat to My OS");
    expect(result.state).toBe("AWAITING_APPROVAL");
    expect(mocks.createApproval).toHaveBeenCalledWith("user-1", "engineering_plan", expect.objectContaining({ route: "self_improvement", executionRunId: "run-1" }));
    expect(mocks.appendExecutionEvent).toHaveBeenLastCalledWith("run-1", expect.objectContaining({ phase: "waiting_for_approval", status: "waiting_approval" }));
    expect(mocks.runCouncilProvider).toHaveBeenCalledTimes(3);
  });
});
