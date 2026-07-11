import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { importApprovedSkillScoutItem } from "@/lib/skill-scout/importer";

beforeEach(() => {
  vi.clearAllMocks();
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
});
