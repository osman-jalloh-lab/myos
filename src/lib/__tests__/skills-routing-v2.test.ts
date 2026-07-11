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
import { inferAgent, scoreRegisteredSkill } from "@/lib/skills/scoring";
import { resolveRelevantSkills, skillInstructionBlock } from "@/lib/skills/routing";
import { skillResolutionToExecutionPlan } from "@/lib/hermes-execution/execution-bridge";

describe("skill routing v2", () => {
  it("routes I-9 document requests to the specific HR skill and injects safe behavior", async () => {
    clearSkillRegistryCache();
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "I need to ask an employee for their I-9 document.",
      maxSkills: 4,
    });

    expect(resolution.primarySkill?.id).toBe("i9-hr-compliance-specialist");
    expect(resolution.primarySkill?.confidence).toBeGreaterThanOrEqual(75);
    expect(resolution.explanation).toMatch(/Primary skill i9-hr-compliance-specialist/i);
    expect(skillInstructionBlock(resolution)).toMatch(/employee chooses|Employees choose|Do not tell an employee/i);
    expect(skillInstructionBlock(resolution)).toMatch(/ApprovalAction requirements/i);
  });

  it("lets GRC-specific screening beat generic job application ops while retaining support", async () => {
    clearSkillRegistryCache();
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "Score this GRC internship against my Security+ and CySA+ background and tell me whether to apply.",
      maxSkills: 4,
    });

    expect(resolution.primarySkill?.id).toBe("grc-risk-role-screener");
    expect(resolution.primarySkill?.confidence).toBeGreaterThanOrEqual(75);
    expect(resolution.supportingSkills.map((skill) => skill.id)).toContain("job-application-ops");
    expect(resolution.supportingSkills.map((skill) => skill.id)).toContain("personal-context-anchor");
  });

  it("pairs student authorization with job application workflow for sponsorship internship questions", async () => {
    clearSkillRegistryCache();
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "My internship asks if I need sponsorship and I want to apply anyway.",
      maxSkills: 4,
    });

    expect(resolution.primarySkill?.id).toBe("student-work-authorization-guard");
    expect(resolution.supportingSkills.map((skill) => skill.id)).toContain("job-application-ops");
    expect(resolution.missingContextQuestions.length).toBeGreaterThanOrEqual(0);
  });

  it("routes writing and help desk examples to their own primary skills", async () => {
    clearSkillRegistryCache();
    const writing = await resolveRelevantSkills({
      userId: "user_1",
      message: "Make this email sound less robotic.",
      maxSkills: 4,
    });
    const helpDesk = await resolveRelevantSkills({
      userId: "user_1",
      message: "Write a ticket note for VPN not connecting.",
      maxSkills: 4,
    });

    expect(writing.primarySkill?.id).toBe("writing-humanizer");
    expect(helpDesk.primarySkill?.id).toBe("it-help-desk-trainer");
    expect(helpDesk.primarySkill?.confidence).toBeGreaterThanOrEqual(75);
  });

  it("honors embedded evaluation prompts for positive and negative examples", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);

    for (const id of PERSONAL_SKILL_IDS) {
      const skill = skills.find((entry) => entry.id === id);
      expect(skill, id).toBeTruthy();
      for (const prompt of skill?.evaluationPrompts ?? []) {
        const score = scoreRegisteredSkill(skill!, prompt.input, inferAgent(prompt.input, null));
        if (prompt.shouldMatch) {
          expect(score.score, `${id}: ${prompt.input}`).toBeGreaterThanOrEqual(prompt.minimumScore ?? 75);
        } else {
          expect(score.score, `${id}: ${prompt.input}`).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it("keeps approval-required skills marked approval-required", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);
    const approvalSkills = skills.filter((skill) => [
      "i9-hr-compliance-specialist",
      "student-work-authorization-guard",
      "job-application-ops",
    ].includes(skill.id));

    expect(approvalSkills).toHaveLength(3);
    expect(approvalSkills.every((skill) => skill.safetyClass === "approval_required")).toBe(true);
    expect(approvalSkills.every((skill) => skill.approvalRequiredFor.length > 0)).toBe(true);
  });

  it("turns an executable primary skill into an execution plan", async () => {
    clearSkillRegistryCache();
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "Check my email for recruiter follow-ups.",
      maxSkills: 3,
    });

    const plan = skillResolutionToExecutionPlan(resolution, "Check my email for recruiter follow-ups.");

    expect(resolution.primarySkill?.executionTool).toBeTruthy();
    expect(plan?.intent).toBe(`skill:${resolution.primarySkill?.id}`);
    expect(plan?.steps[0]?.tool).toBe(resolution.primarySkill?.executionTool);
    expect(plan?.steps[0]?.requiresApproval).toBe(true);
  });

  it("resolves build-orchestrator for main-thread build messages", async () => {
    clearSkillRegistryCache();
    const resolution = await resolveRelevantSkills({
      userId: "user_1",
      message: "Continue all the builds and give me the logs after.",
      maxSkills: 4,
    });

    expect(resolution.primarySkill?.id).toBe("build-orchestrator");
    expect(resolution.primarySkill?.confidence).toBeGreaterThanOrEqual(75);
  });
});
