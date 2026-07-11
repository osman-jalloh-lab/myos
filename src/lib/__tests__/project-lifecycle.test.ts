import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBuildProject: vi.fn(),
  updateProjectStatus: vi.fn(),
  createProjectTask: vi.fn(),
  createProjectTasksFromPlan: vi.fn(),
  createApproval: vi.fn(),
}));

vi.mock("@/lib/memory-context", () => ({
  ensureBuildProject: mocks.ensureBuildProject,
  updateProjectStatus: mocks.updateProjectStatus,
  createProjectTask: mocks.createProjectTask,
  createProjectTasksFromPlan: mocks.createProjectTasksFromPlan,
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: mocks.createApproval,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(async () => undefined),
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

import { registerInternalTools } from "@/lib/hermes-execution/tools/internal-tools";
import { getTool } from "@/lib/hermes-execution/tool-registry";
import type { ToolContext } from "@/lib/hermes-execution/types";
import { clearSkillRegistryCache, getRegisteredSkills } from "@/lib/skills/registry";

const ctx: ToolContext = {
  userId: "user_1",
  sessionId: "session_1",
  source: "api",
  previousResults: {},
  env: { NODE_ENV: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  registerInternalTools();
  mocks.ensureBuildProject.mockResolvedValue({
    id: "project_1",
    userId: "user_1",
    projectName: "Campus Jobs Board",
    description: null,
    route: "/campus-jobs-board",
    status: "building",
    latestInstruction: "Start a campus jobs board.",
    assignedAgent: "hermes-execution",
  });
  mocks.createProjectTask.mockResolvedValue({
    id: "task_intake",
    projectId: "project_1",
    userId: "user_1",
    title: "Clarify project scope",
    description: "Start a campus jobs board.",
    status: "pending",
    assignedAgent: "project-starter",
    nextStep: "Confirm scope.",
  });
  mocks.createProjectTasksFromPlan.mockResolvedValue([
    {
      id: "task_plan",
      projectId: "project_1",
      userId: "user_1",
      title: "Draft architecture and data model",
      description: "Plan the build.",
      status: "pending",
      assignedAgent: "project-starter",
      nextStep: null,
    },
  ]);
  mocks.createApproval.mockResolvedValue({
    id: "approval_1",
    actionType: "engineering_plan",
    payload: {},
    status: "pending",
    createdAt: "2026-07-11T00:00:00.000Z",
    resolvedAt: null,
  });
});

describe("project lifecycle tools", () => {
  it("creates a project, saves a plan, and blocks handoff behind approval", async () => {
    const create = getTool("internal.projects.create");
    const plan = getTool("internal.projects.plan");
    const handoff = getTool("internal.projects.requestHandoff");

    expect(create).toBeTruthy();
    expect(plan).toBeTruthy();
    expect(handoff).toBeTruthy();

    const createResult = await create!.execute(
      { message: "Start a campus jobs board for UT students." },
      ctx
    ) as { projectId: string; answer: string };

    const planResult = await plan!.execute(
      { message: "Plan the campus jobs board.", projectId: createResult.projectId },
      ctx
    ) as { projectId: string; planSteps: unknown[]; answer: string };

    const handoffResult = await handoff!.execute(
      { message: "Hand this to build-orchestrator.", projectId: planResult.projectId, planSteps: planResult.planSteps },
      ctx
    ) as { answer: string };

    expect(mocks.ensureBuildProject).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "/campus-jobs-board",
      "Start a campus jobs board for UT students."
    );
    expect(mocks.updateProjectStatus).toHaveBeenCalledWith("project_1", "planning");
    expect(mocks.createProjectTasksFromPlan).toHaveBeenCalledWith(
      "project_1",
      "user_1",
      expect.arrayContaining([
        expect.objectContaining({ assignedAgent: "project-starter" }),
        expect.objectContaining({ assignedAgent: "build-orchestrator" }),
      ])
    );
    expect(mocks.createApproval).toHaveBeenCalledWith(
      "user_1",
      "engineering_plan",
      expect.objectContaining({
        projectId: "project_1",
        handoffTarget: "build-orchestrator",
        source: "project-starter",
      })
    );
    expect(handoffResult.answer).toContain("queued for approval");
    expect(handoffResult.answer).toContain("No implementation handoff has run yet");
  });

  it("exposes project-starter as an executable internal-write skill", async () => {
    clearSkillRegistryCache();
    const skills = await getRegisteredSkills("user_1", true);
    const projectStarter = skills.find((skill) => skill.id === "project-starter");

    expect(projectStarter).toBeTruthy();
    expect(projectStarter?.executionTool).toBe("internal.projects.create");
    expect(projectStarter?.executionRisk).toBe("internal_write");
  });
});
