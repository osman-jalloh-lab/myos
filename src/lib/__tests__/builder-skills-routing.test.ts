import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async () => undefined),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/local-projects-root", () => ({
  resolveLocalProjectsRoot: vi.fn(() => "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject"),
}));

import { clearSkillRegistryCache } from "@/lib/skills/registry";
import { resolveRelevantSkills } from "@/lib/skills/routing";
import type { SkillEvaluationPrompt } from "@/lib/skills/types";

const BUILDER_SKILL_IDS = [
  "build-orchestrator",
  "project-starter",
  "local-worker-status",
  "repo-change-planner",
  "build-validation-runner",
] as const;

type BuilderSkillDefinition = {
  evaluationPrompts?: SkillEvaluationPrompt[];
};

async function readBuilderSkillDefinition(id: string): Promise<BuilderSkillDefinition> {
  const raw = await readFile(path.join(process.cwd(), "skills", `${id}.json`), "utf8");
  return JSON.parse(raw) as BuilderSkillDefinition;
}

describe("builder skill routing from JSON evals", () => {
  beforeEach(() => clearSkillRegistryCache());
  afterEach(() => clearSkillRegistryCache());

  it("passes every builder JSON evaluation prompt through real skill resolution", async () => {
    for (const id of BUILDER_SKILL_IDS) {
      const definition = await readBuilderSkillDefinition(id);
      expect(definition.evaluationPrompts?.length, `${id} eval prompt count`).toBeGreaterThanOrEqual(5);

      for (const prompt of definition.evaluationPrompts ?? []) {
        const resolution = await resolveRelevantSkills({
          userId: "user_1",
          message: prompt.input,
          maxSkills: 4,
        });
        const actual = resolution.primarySkill?.id ?? "none";
        const label = `${id}: ${prompt.input}`;

        expect(prompt.expectedSkill, label).toBeTruthy();
        if (prompt.shouldMatch) {
          expect(actual, label).toBe(prompt.expectedSkill);
          if (prompt.minimumScore !== undefined) {
            expect(resolution.primarySkill?.confidence ?? 0, label).toBeGreaterThanOrEqual(prompt.minimumScore);
          }
        } else {
          expect(actual, label).not.toBe(id);
          expect(actual, label).toBe(prompt.expectedSkill);
        }
      }
    }
  });

  it("keeps the seven personal skills ahead of builder skills for canonical prompts", async () => {
    const cases = [
      {
        message: "Use my Security+ and CySA+ background when you answer this.",
        expected: "personal-context-anchor",
      },
      {
        message: "HR sent me an I-9 and E-Verify work authorization question. What should I do?",
        expected: "i9-hr-compliance-specialist",
      },
      {
        message: "Draft a recruiter follow-up for my job application.",
        expected: "job-application-ops",
      },
      {
        message: "Write a ticket note for VPN not connecting.",
        expected: "it-help-desk-trainer",
      },
      {
        message: "Score this GRC internship for me.",
        expected: "grc-risk-role-screener",
      },
      {
        message: "My internship asks if I need sponsorship and I want to apply anyway.",
        expected: "student-work-authorization-guard",
      },
      {
        message: "Make this email sound less robotic.",
        expected: "writing-humanizer",
      },
    ];

    for (const testCase of cases) {
      const resolution = await resolveRelevantSkills({
        userId: "user_1",
        message: testCase.message,
        maxSkills: 4,
      });

      expect(resolution.primarySkill?.id, testCase.message).toBe(testCase.expected);
      expect(resolution.primarySkill?.id, testCase.message).not.toBe("build-orchestrator");
      expect(resolution.primarySkill?.id, testCase.message).not.toBe("local-worker-status");
    }
  });
});
