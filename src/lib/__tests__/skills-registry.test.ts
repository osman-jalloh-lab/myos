import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(async () => undefined),
  queryRaw: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRaw,
  },
}));

vi.mock("@/lib/local-projects-root", () => ({
  resolveLocalProjectsRoot: vi.fn(() => "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject"),
}));

import { checkDuplicateSkill, clearSkillRegistryCache, getRegisteredSkills } from "@/lib/skills/registry";

const PERSONAL_SKILLS = [
  "personal-context-anchor",
  "i9-hr-compliance-specialist",
  "job-application-ops",
  "it-help-desk-trainer",
  "grc-risk-role-screener",
  "student-work-authorization-guard",
  "writing-humanizer",
];

describe("skills registry", () => {
  it("guards state-table DDL while still reading state for each registry call", async () => {
    clearSkillRegistryCache();
    mocks.executeRaw.mockClear();
    mocks.queryRaw.mockClear();

    await getRegisteredSkills("user_1", true);
    await getRegisteredSkills("user_1");

    const ddlCalls = mocks.executeRaw.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("CREATE TABLE IF NOT EXISTS SkillRegistryState")
    );
    const stateReads = mocks.queryRaw.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("FROM SkillRegistryState")
    );
    expect(ddlCalls).toHaveLength(1);
    expect(stateReads).toHaveLength(2);
  });

  it("surfaces the seven real imported personal skills with metadata", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);
    for (const id of PERSONAL_SKILLS) {
      const skill = skills.find((entry) => entry.id === id);
      expect(skill, id).toBeTruthy();
      expect(skill?.description).toBeTruthy();
      expect(skill?.ownerAgents.length).toBeGreaterThan(0);
      expect(skill?.tags.length).toBeGreaterThan(0);
      expect(skill?.source).toBe("installed");
      expect(skill?.validationStatus).toBe("valid");
    }
  });

  it("reports duplicate add as a clear no-op", async () => {
    clearSkillRegistryCache();
    const duplicate = await checkDuplicateSkill("user_1", "personal-context-anchor");
    expect(duplicate).toMatchObject({
      duplicate: true,
      message: "personal-context-anchor is already installed; no action taken.",
    });
  });
});
