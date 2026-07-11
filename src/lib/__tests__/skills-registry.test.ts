import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(async () => undefined),
  queryRaw: vi.fn(async () => []),
  userSkillFindMany: vi.fn<() => Promise<unknown[]>>(async () => []),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRaw,
    userSkill: {
      findMany: mocks.userSkillFindMany,
    },
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
  beforeEach(() => {
    mocks.userSkillFindMany.mockResolvedValue([]);
  });

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

  it("merges DB-backed skills while skipping malformed JSON and letting filesystem skills win duplicate ids", async () => {
    clearSkillRegistryCache();
    mocks.userSkillFindMany.mockResolvedValue([
      {
        skillId: "db-weekly-review",
        name: "DB Weekly Review",
        description: "Summarize a weekly plan from user-owned skill metadata.",
        category: "planning",
        definition: JSON.stringify({
          ownerAgents: ["hermes"],
          tags: ["planning", "review"],
          safetyClass: "read_only",
          triggerExamples: ["Review my week"],
          instructions: "Build a concise weekly review.",
        }),
        enabled: true,
        createdAt: new Date("2026-07-11T00:00:00Z"),
        updatedAt: new Date("2026-07-11T00:00:00Z"),
      },
      {
        skillId: "bad-json-skill",
        name: "Bad JSON",
        description: "This malformed row should not break registry loading.",
        category: "broken",
        definition: "{not json",
        enabled: true,
        createdAt: new Date("2026-07-11T00:00:00Z"),
        updatedAt: new Date("2026-07-11T00:00:00Z"),
      },
      {
        skillId: "personal-context-anchor",
        name: "DB Duplicate",
        description: "A duplicate DB skill should not replace the filesystem skill.",
        category: "duplicate",
        definition: JSON.stringify({
          ownerAgents: ["hermes"],
          tags: ["duplicate"],
          safetyClass: "read_only",
          instructions: "Duplicate.",
        }),
        enabled: true,
        createdAt: new Date("2026-07-11T00:00:00Z"),
        updatedAt: new Date("2026-07-11T00:00:00Z"),
      },
    ]);

    const skills = await getRegisteredSkills("user_1", true);
    const dbSkill = skills.find((skill) => skill.id === "db-weekly-review");
    const malformed = skills.find((skill) => skill.id === "bad-json-skill");
    const duplicate = skills.find((skill) => skill.id === "personal-context-anchor");

    expect(dbSkill).toMatchObject({
      id: "db-weekly-review",
      name: "DB Weekly Review",
      source: "user",
      validationStatus: "valid",
    });
    expect(dbSkill?.instructionPreview).toContain("weekly review");
    expect(malformed).toBeUndefined();
    expect(duplicate?.source).toBe("installed");
    expect(duplicate?.name).not.toBe("DB Duplicate");
  });
});
