import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hermes-execution/capabilities", () => ({
  getCapabilitySnapshot: vi.fn(async () => ({
    tools: [{ name: "internal.code.buildFeature" }],
    worker: { status: "online" },
    buildExecution: { available: true },
  })),
}));

vi.mock("@/lib/skills/registry", () => ({
  getRegisteredSkills: vi.fn(async () => [
    {
      id: "project-starter",
      name: "Project Starter",
      description: "Project planning and project kickoff",
      tags: ["project", "planning"],
    },
  ]),
}));

import { completionEvidenceSummary } from "@/lib/project-control/project-completion";
import {
  createDeterministicProjectPlan,
  resolveCapabilities,
  shouldUseCouncil,
} from "@/lib/project-control/project-planner";
import {
  nextProjectPhase,
  taskBlockedByUnfinishedDependencies,
  taskWakeupIdempotencyKey,
} from "@/lib/project-control/project-state-machine";
import { canArmSkillVersion, evaluateExternalSkillSource } from "@/lib/project-control/skill-agency";

describe("project control plane", () => {
  it("routes simple supported work directly to the Project Manager", () => {
    expect(shouldUseCouncil("Build me a website for a residential home-building project manager.")).toBe(false);
    const plan = createDeterministicProjectPlan("Build me a website for a residential home-building project manager.");

    expect(plan.needsCouncil).toBe(false);
    expect(plan.tasks.map((task) => task.assignedAgent)).toEqual([
      "project-manager",
      "prometheus",
      "fugu",
      "argus",
    ]);
  });

  it("routes ambiguous high-risk multi-domain work through Council", () => {
    expect(shouldUseCouncil("Design an enterprise multi-domain compliance platform with payments and legal workflows.")).toBe(true);
  });

  it("uses explicit dependencies to block downstream tasks until blockers complete", () => {
    const blocked = taskBlockedByUnfinishedDependencies(
      [{ taskId: "task_build", blockingTaskId: "task_plan" }],
      [
        { id: "task_plan", status: "ready" },
        { id: "task_build", status: "backlog" },
      ]
    );

    expect(blocked.has("task_build")).toBe(true);
  });

  it("creates deterministic wakeup keys so duplicate assignment coalesces", () => {
    const key = taskWakeupIdempotencyKey({
      projectId: "project_1",
      taskId: "task_1",
      agentKey: "prometheus",
      reason: "task_ready",
      taskVersion: "v1",
    });

    expect(key).toBe("project_1:task_1:prometheus:task_ready:v1");
  });

  it("keeps active projects executing and only completes with evidence", () => {
    expect(nextProjectPhase({
      acceptedPlan: true,
      unresolvedCapabilityGaps: 0,
      readyTasks: 0,
      activeTasks: 1,
      reviewTasks: 0,
      qaTasks: 0,
      failedTasks: 0,
      blockedTasks: 0,
      completedRequiredTasks: 1,
      totalRequiredTasks: 3,
      completionEvidenceCount: 1,
    })).toBe("executing");

    expect(completionEvidenceSummary([
      { status: "completed", completedAt: new Date(), nextStep: "Evidence: test passed" },
      { status: "completed", completedAt: new Date(), nextStep: null },
    ])).toEqual({
      requiredTaskCount: 2,
      evidencedTaskCount: 1,
      complete: false,
    });
  });

  it("classifies missing credentials as setup blockers, not skill acquisition", async () => {
    const resolutions = await resolveCapabilities("user_1", [
      { name: "gmail", type: "credential", required: true },
      { name: "local-build", type: "tool", required: true },
    ]);

    expect(resolutions).toEqual([
      expect.objectContaining({ name: "gmail", state: "missing_credential" }),
      expect.objectContaining({ name: "local-build", state: "available" }),
    ]);
  });

  it("rejects floating or unsafe external skill imports", () => {
    const result = evaluateExternalSkillSource({
      repository: "https://github.com/example/skill",
      filePath: "skills/example/SKILL.md",
      commitSha: "main",
      trustLevel: "untrusted",
      fileInventory: ["skills/example/run.ts", ".env"],
      guidanceOnly: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.requiresAdapterTask).toBe(true);
    expect(result.reasons.join(" ")).toContain("exact commit SHA");
  });

  it("allows executable skill arming only after validation and approval", () => {
    expect(canArmSkillVersion({
      guidanceOnly: true,
      toolExists: true,
      adapterValidationPassed: true,
      typecheckPassed: true,
      testsPassed: true,
      securityReviewPassed: true,
      approvalAccepted: true,
    }).allowed).toBe(false);

    expect(canArmSkillVersion({
      guidanceOnly: false,
      toolExists: true,
      adapterValidationPassed: true,
      typecheckPassed: true,
      testsPassed: true,
      securityReviewPassed: true,
      approvalAccepted: true,
    }).allowed).toBe(true);
  });
});
