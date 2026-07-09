import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  createApproval: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRawUnsafe: mocks.queryRaw,
  },
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: mocks.createApproval,
}));

import { generateSelfImprovementProposal, queueSelfImprovementProposal } from "@/lib/self-improvement";

describe("safe self-improvement proposals", () => {
  it("generates a structured proposal from real skill telemetry rows", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([
      {
        skillId: "i9-hr-compliance-specialist",
        skillName: "I-9 HR Compliance Specialist",
        usageCount: 4,
        avoidedCount: 2,
        lastUsedAt: "2026-07-09T20:00:00Z",
      },
    ]);

    const proposal = await generateSelfImprovementProposal("user_1");

    expect(proposal.mode).toBe("dreaming");
    expect(proposal.observedIssue).toMatch(/SkillUsageTelemetry/i);
    expect(proposal.riskLevel).toBe("low");
    expect(proposal.filesLikelyAffected).toContain("src/lib/skills/routing.ts");
    expect(proposal.requiredTests).toContain("npm run build");
    expect(proposal.branchImplementation).toMatch(/Not started/i);
    expect(proposal.prohibitedWithoutApproval).toContain(".env files");
  });

  it("queues the proposal through the existing ApprovalAction path only", async () => {
    mocks.queryRaw.mockReset();
    mocks.createApproval.mockReset();
    mocks.queryRaw.mockResolvedValueOnce([
      {
        skillId: "writing-humanizer",
        skillName: "Writing Humanizer",
        usageCount: 1,
        avoidedCount: 0,
        lastUsedAt: "2026-07-09T20:00:00Z",
      },
    ]);
    mocks.createApproval.mockResolvedValue({
      id: "approval_1",
      actionType: "self_improvement_proposal",
      payload: {},
      status: "pending",
      createdAt: "2026-07-09T20:00:00Z",
      resolvedAt: null,
    });

    await queueSelfImprovementProposal("user_1");

    expect(mocks.createApproval).toHaveBeenCalledTimes(1);
    expect(mocks.createApproval.mock.calls[0][1]).toBe("self_improvement_proposal");
    expect(mocks.createApproval.mock.calls[0][2]).toMatchObject({
      mode: "dreaming",
      branchImplementation: expect.stringMatching(/Not started/i),
      validationResult: expect.stringMatching(/Not run/i),
    });
  });
});
