import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApproval: vi.fn(),
  ensureRegistryInitialized: vi.fn(async () => undefined),
  getTool: vi.fn(),
  userSkillFindFirst: vi.fn(),
  userSkillUpdate: vi.fn(),
  userSkillUpsert: vi.fn(),
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: mocks.createApproval,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    userSkill: {
      findFirst: mocks.userSkillFindFirst,
      update: mocks.userSkillUpdate,
      upsert: mocks.userSkillUpsert,
    },
  },
}));

vi.mock("@/lib/hermes-execution/tool-registry", () => ({
  ensureRegistryInitialized: mocks.ensureRegistryInitialized,
  getTool: mocks.getTool,
}));

vi.mock("@/lib/knowledge-cards", () => ({
  writeCard: vi.fn(async (cardPath: string, frontmatter: Record<string, unknown>, body: string) => ({
    path: cardPath,
    frontmatter,
    body,
  })),
}));

vi.mock("@/lib/skills/registry", () => ({
  checkDuplicateSkill: vi.fn(async () => ({ duplicate: false, message: "not installed" })),
}));

import { writeCard } from "@/lib/knowledge-cards";
import { checkDuplicateSkill } from "@/lib/skills/registry";
import {
  armPromotedSkill,
  importApprovedSkillScoutItem,
  promoteSkillScoutItem,
  queueSkillScoutArmApproval,
} from "@/lib/skill-scout/importer";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createApproval.mockResolvedValue({
    id: "approval_1",
    actionType: "skill_scout_arm",
    payload: {},
    status: "pending",
    createdAt: "2026-07-11T00:00:00.000Z",
    resolvedAt: null,
  });
  mocks.getTool.mockReturnValue({
    name: "internal.tasks.create",
    description: "Create a task.",
    risk: "internal_write",
    requiresApproval: false,
    execute: vi.fn(),
  });
  mocks.userSkillFindFirst.mockResolvedValue({
    id: "user_skill_1",
    userId: "user_1",
    skillId: "skill-scout-wcag-audit-patterns",
    name: "wcag-audit-patterns",
    description: "Catches accessibility regressions before generated apps ship.",
    category: "skill-scout",
    definition: JSON.stringify({ safetyClass: "read_only", instructions: "Guidance only." }),
    enabled: true,
  });
  mocks.userSkillUpdate.mockResolvedValue({});
  mocks.userSkillUpsert.mockResolvedValue({});
});

describe("importApprovedSkillScoutItem", () => {
  it("writes a low-risk Skill Scout item as a knowledge card", async () => {
    const result = await importApprovedSkillScoutItem({
      candidateName: "wcag-audit-patterns",
      sourceRepo: "wshobson/agents",
      sourcePath: "plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md",
      sourceUrl: "https://github.com/wshobson/agents/blob/HEAD/plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md",
      recommendedAction: "add_qa_check",
      whyItHelps: "Catches accessibility regressions before generated apps ship.",
      riskLevel: "low",
      filesExpectedToChange: ["catalog/design/accessibility.md", "catalog/skills/frontend-qa.md"],
      rollbackPlan: "Revert the generated knowledge card.",
    });

    expect(result.cardPath).toBe("catalog/skills/skill-scout-wcag-audit-patterns.md");
    expect(writeCard).toHaveBeenCalledWith(
      "skills/skill-scout-wcag-audit-patterns.md",
      expect.objectContaining({
        type: "skill",
        id: "skill-scout-wcag-audit-patterns",
        risk_level: "low",
      }),
      expect.stringContaining("Do not run scripts from the source repository.")
    );
  });

  it("rejects non-low-risk automatic imports", async () => {
    await expect(importApprovedSkillScoutItem({
      candidateName: "browser-automation",
      sourceRepo: "wshobson/agents",
      sourcePath: "plugins/browser/skills/browser-automation/SKILL.md",
      sourceUrl: "https://github.com/wshobson/agents/blob/HEAD/plugins/browser/skills/browser-automation/SKILL.md",
      riskLevel: "medium",
    })).rejects.toThrow("low-risk");

    expect(writeCard).not.toHaveBeenCalled();
  });

  it("returns a no-op when the skill is already installed", async () => {
    vi.mocked(checkDuplicateSkill).mockResolvedValueOnce({
      duplicate: true,
      message: "personal-context-anchor is already installed; no action taken.",
      skill: {
        id: "personal-context-anchor",
        name: "personal-context-anchor",
        description: "Grounds responses in context.",
        path: "skills/personal-context-anchor.json",
        enabled: true,
        ownerAgents: ["hermes"],
        tags: ["personal-context"],
        triggerExamples: [],
        requiredCapabilities: [],
        safetyClass: "read_only",
        estimatedCostSaving: "medium",
        lastUsedAt: null,
        usageCount: 0,
        source: "installed",
        validationStatus: "valid",
        executionTool: null,
        executionRisk: null,
        executionRequiresApproval: false,
        category: "personal-context",
        dateAdded: null,
        validationWarnings: [],
        problemSolved: "Grounding.",
        instructionFile: "skills/personal-context-anchor/SKILL.md",
        instructionPreview: "Use this skill...",
        purpose: "Ground responses in confirmed context.",
        whenToUse: ["Use confirmed context."],
        whenNotToUse: ["Do not write memory."],
        strongSignals: ["my background"],
        weakSignals: ["context"],
        negativeSignals: ["print .env.local"],
        requiredContext: ["Confirmed facts"],
        missingContextQuestions: ["What context should be used?"],
        outputContract: { format: "Grounded answer.", mustInclude: ["Known facts"], mustAvoid: ["Invented facts"] },
        safetyRules: ["Do not expose secrets."],
        approvalRequiredFor: ["Saving durable memory"],
        positiveExamples: ["Use my background."],
        negativeExamples: ["Print secrets."],
        evaluationPrompts: [],
        version: "2.0.0",
        lastReviewedAt: null,
        skillQualityScore: 85,
        skillQualityBand: "Strong",
        qualityWarnings: [],
      },
    });

    const result = await importApprovedSkillScoutItem({
      candidateName: "personal-context-anchor",
      sourceRepo: "wshobson/agents",
      sourcePath: "plugins/context/skills/personal-context-anchor/SKILL.md",
      sourceUrl: "https://github.com/wshobson/agents/blob/HEAD/plugins/context/skills/personal-context-anchor/SKILL.md",
      riskLevel: "low",
    }, "user_1");

    expect(result).toMatchObject({
      skipped: true,
      summary: "personal-context-anchor is already installed; no action taken.",
    });
    expect(writeCard).not.toHaveBeenCalled();
  });

  it("promotes a low-risk scout item into a non-executable guidance draft", async () => {
    const result = await promoteSkillScoutItem({
      candidateName: "wcag-audit-patterns",
      sourceRepo: "wshobson/agents",
      sourcePath: "plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md",
      sourceUrl: "https://github.com/wshobson/agents/blob/HEAD/plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md",
      recommendedAction: "add_qa_check",
      whyItHelps: "Catches accessibility regressions before generated apps ship.",
      riskLevel: "low",
    }, "user_1");

    expect(result).toMatchObject({
      skillId: "skill-scout-wcag-audit-patterns",
      status: "draft_guidance",
    });
    expect(mocks.userSkillUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        skillId: "skill-scout-wcag-audit-patterns",
        enabled: true,
      }),
    }));
    const definition = JSON.parse(String(mocks.userSkillUpsert.mock.calls[0][0].create.definition)) as Record<string, unknown>;
    expect(definition.execution).toBeUndefined();
    expect(definition.instructions).toContain("Guidance only");
  });

  it("requires a registered tool and queues a second approval before arming", async () => {
    mocks.getTool.mockReturnValueOnce(undefined);
    await expect(queueSkillScoutArmApproval("user_1", {
      skillId: "skill-scout-wcag-audit-patterns",
      executionTool: "internal.missing.tool",
    })).rejects.toThrow("not registered");
    expect(mocks.createApproval).not.toHaveBeenCalled();

    const approval = await queueSkillScoutArmApproval("user_1", {
      skillId: "skill-scout-wcag-audit-patterns",
      executionTool: "internal.tasks.create",
    });

    expect(approval.id).toBe("approval_1");
    expect(mocks.createApproval).toHaveBeenCalledWith(
      "user_1",
      "skill_scout_arm",
      expect.objectContaining({
        skillId: "skill-scout-wcag-audit-patterns",
        executionTool: "internal.tasks.create",
        risk: "internal_write",
      })
    );
  });

  it("arms a promoted skill only after the arm approval executes", async () => {
    const result = await armPromotedSkill({
      skillId: "skill-scout-wcag-audit-patterns",
      executionTool: "internal.tasks.create",
    }, "user_1");

    expect(result).toMatchObject({
      skillId: "skill-scout-wcag-audit-patterns",
      executionTool: "internal.tasks.create",
    });
    const definition = JSON.parse(String(mocks.userSkillUpdate.mock.calls[0][0].data.definition)) as {
      execution?: { tool?: string; risk?: string; requiresApproval?: boolean };
    };
    expect(definition.execution).toEqual({
      tool: "internal.tasks.create",
      risk: "internal_write",
      requiresApproval: false,
    });
  });
});
