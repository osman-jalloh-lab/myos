import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async () => undefined),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/local-projects-root", () => ({
  resolveLocalProjectsRoot: vi.fn(() => "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject"),
}));

import {
  clearSkillRegistryCache,
  getRegisteredSkills,
  PERSONAL_SKILL_IDS,
} from "@/lib/skills/registry";

describe("skills quality v2", () => {
  it("keeps all core personal skills at strong-or-better quality with complete eval coverage", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);

    for (const id of PERSONAL_SKILL_IDS) {
      const skill = skills.find((entry) => entry.id === id);
      expect(skill, id).toBeTruthy();
      expect(skill?.skillQualityScore, id).toBeGreaterThanOrEqual(85);
      expect(skill?.purpose, id).toBeTruthy();
      expect(skill?.whenToUse.length, id).toBeGreaterThanOrEqual(3);
      expect(skill?.whenNotToUse.length, id).toBeGreaterThanOrEqual(2);
      expect(skill?.strongSignals.length, id).toBeGreaterThanOrEqual(4);
      expect(skill?.negativeSignals.length, id).toBeGreaterThanOrEqual(3);
      expect(skill?.outputContract.mustInclude.length, id).toBeGreaterThan(0);
      expect(skill?.outputContract.mustAvoid.length, id).toBeGreaterThan(0);
      expect(skill?.safetyRules.length, id).toBeGreaterThanOrEqual(3);
      expect(skill?.positiveExamples.length, id).toBeGreaterThanOrEqual(5);
      expect(skill?.negativeExamples.length, id).toBeGreaterThanOrEqual(3);

      const prompts = skill?.evaluationPrompts ?? [];
      expect(prompts.filter((prompt) => prompt.shouldMatch).length, id).toBeGreaterThanOrEqual(5);
      expect(prompts.filter((prompt) => !prompt.shouldMatch).length, id).toBeGreaterThanOrEqual(3);
      expect(prompts.filter((prompt) => /ambiguous/i.test(prompt.reason)).length, id).toBeGreaterThanOrEqual(2);
      expect(prompts.filter((prompt) => /multi-skill/i.test(prompt.reason)).length, id).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps durable or external actions behind approval-oriented skill metadata", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);
    const approvalRequired = [
      "i9-hr-compliance-specialist",
      "student-work-authorization-guard",
      "job-application-ops",
    ];

    for (const id of approvalRequired) {
      const skill = skills.find((entry) => entry.id === id);
      expect(skill?.safetyClass, id).toBe("approval_required");
      expect(skill?.approvalRequiredFor.join(" "), id).toMatch(/Sending|Submitting|Creating|Updating|Saving/i);
      expect(skill?.safetyRules.join(" "), id).toMatch(/approval|Do not|Keep/i);
    }

    const scouted = skills.filter((skill) => skill.source === "scouted");
    expect(scouted.every((skill) => skill.safetyClass !== "local_execution")).toBe(true);
  });
});
