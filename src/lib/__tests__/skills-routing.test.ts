import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(async () => []),
  executeRaw: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRaw,
  },
}));

vi.mock("@/lib/skills/registry", () => ({
  getRegisteredSkills: vi.fn(async () => [
    {
      id: "i9-hr-compliance-specialist",
      name: "I-9 HR Compliance Specialist",
      description: "Guides HR compliance around Form I-9, E-Verify, and employment eligibility.",
      path: "skills/i9-hr-compliance-specialist",
      enabled: true,
      ownerAgents: ["themis", "iris", "hermes"],
      tags: ["i9", "hr", "compliance", "work authorization"],
      triggerExamples: ["An employee has an I-9 or E-Verify question."],
      requiredCapabilities: ["hr_compliance"],
      safetyClass: "approval_required",
      estimatedCostSaving: "medium",
      lastUsedAt: null,
      usageCount: 0,
      source: "installed",
      validationStatus: "valid",
      category: "hr",
      dateAdded: null,
      validationWarnings: [],
      problemSolved: "This skill can help Themis answer I-9 and E-Verify questions from safe local policy context.",
      instructionFile: "skills/i9-hr-compliance-specialist/SKILL.md",
      instructionPreview: "Do not bypass approval.",
    },
    {
      id: "writing-humanizer",
      name: "Writing Humanizer",
      description: "Makes drafts sound natural and direct.",
      path: "skills/writing-humanizer",
      enabled: true,
      ownerAgents: ["hermes"],
      tags: ["writing", "tone"],
      triggerExamples: ["Rewrite this to sound more human."],
      requiredCapabilities: [],
      safetyClass: "read_only",
      estimatedCostSaving: "low",
      lastUsedAt: null,
      usageCount: 0,
      source: "installed",
      validationStatus: "valid",
      category: "writing",
      dateAdded: null,
      validationWarnings: [],
      problemSolved: "This skill can make drafts sound more human.",
      instructionFile: "skills/writing-humanizer/SKILL.md",
      instructionPreview: "Tone guidance.",
    },
  ]),
}));

import {
  formatSkillsUsed,
  recordSkillUsageTelemetry,
  resolveRelevantSkills,
  skillInstructionBlock,
} from "@/lib/skills/routing";

describe("skill-first routing", () => {
  beforeEach(() => {
    mocks.executeRaw.mockClear();
    mocks.queryRaw.mockClear();
  });

  it("selects the I-9 HR skill with a confidence score and concise instruction", async () => {
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "HR sent me an I-9 and E-Verify work authorization question. What should I do?",
      agentName: "themis",
      projectId: "project_1",
      maxSkills: 3,
    });

    expect(resolution.matched).toBe(true);
    expect(resolution.skills[0]).toMatchObject({
      id: "i9-hr-compliance-specialist",
      safetyClass: "approval_required",
    });
    expect(resolution.skills[0].confidence).toBeGreaterThanOrEqual(35);
    expect(resolution.skills[0].reason).toMatch(/i-9|e-verify|work authorization/i);
    expect(skillInstructionBlock(resolution)).toMatch(/Do not bypass ApprovalAction requirements/);
    expect(formatSkillsUsed(resolution)).toContain("i9-hr-compliance-specialist");
  });

  it("falls through visibly when no skill is a confident match", async () => {
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "blue triangle moon pebble qxzv",
      agentName: "hermes",
      maxSkills: 3,
    });

    expect(resolution.matched).toBe(false);
    expect(resolution.skills).toHaveLength(0);
    expect(formatSkillsUsed(resolution)).toMatch(/none matched/i);
  });

  it("persists usage telemetry with guarded DDL and batched usage updates", async () => {
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "I need I-9 employment eligibility guidance.",
      agentName: "themis",
    });
    const primary = resolution.skills[0];
    expect(primary).toBeTruthy();
    const multiSkillResolution = {
      ...resolution,
      matched: true,
      skills: [
        primary!,
        {
          ...primary!,
          id: "writing-humanizer",
          name: "Writing Humanizer",
          confidence: 45,
          reason: "supporting writing skill",
          role: "supporting" as const,
        },
      ],
    };

    await recordSkillUsageTelemetry({ userId: "user_1", resolution: multiSkillResolution, modelCallAvoided: false });

    const calls = mocks.executeRaw.mock.calls.map((call: unknown[]) => String(call[0]));
    const countSql = (pattern: RegExp) => calls.filter((sql) => pattern.test(sql)).length;
    expect(calls.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS SkillUsageTelemetry"))).toBe(true);
    expect(calls.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS SkillRegistryState"))).toBe(true);
    expect(countSql(/INSERT INTO SkillUsageTelemetry/)).toBe(1);
    expect(countSql(/INSERT INTO SkillRegistryState/)).toBe(1);
    const telemetryInsert = mocks.executeRaw.mock.calls.find((call: unknown[]) => String(call[0]).includes("INSERT INTO SkillUsageTelemetry")) as unknown[] | undefined;
    expect(String(telemetryInsert?.[0])).toContain("modelCallAvoided, executed, createdAt");
    expect(telemetryInsert).toHaveLength(23);
    expect(mocks.executeRaw.mock.calls.find((call: unknown[]) => String(call[0]).includes("INSERT INTO SkillRegistryState"))).toHaveLength(5);

    mocks.executeRaw.mockClear();
    await recordSkillUsageTelemetry({ userId: "user_1", resolution: multiSkillResolution, modelCallAvoided: true });

    const warmCalls = mocks.executeRaw.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warmCalls.some((sql) => /CREATE TABLE|CREATE INDEX/.test(sql))).toBe(false);
    expect(warmCalls.filter((sql) => sql.includes("INSERT INTO SkillUsageTelemetry"))).toHaveLength(1);
    expect(warmCalls.filter((sql) => sql.includes("INSERT INTO SkillRegistryState"))).toHaveLength(1);
  });
});
