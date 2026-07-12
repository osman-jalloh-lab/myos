import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  projectTaskCreate: vi.fn(),
  projectPlanUpdate: vi.fn(),
  createProposedProjectPlan: vi.fn(),
  startProjectFromDecision: vi.fn(),
  acceptProjectPlan: vi.fn(),
  resolvePlanCapabilities: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  dispatchQueuedWakeups: vi.fn(),
  getCapabilitySnapshot: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    project: {
      findFirst: mocks.projectFindFirst,
      update: mocks.projectUpdate,
    },
    projectTask: {
      create: mocks.projectTaskCreate,
    },
    projectPlan: {
      update: mocks.projectPlanUpdate,
    },
  },
}));

vi.mock("@/lib/project-control/project-manager", () => ({
  createProposedProjectPlan: mocks.createProposedProjectPlan,
  startProjectFromDecision: mocks.startProjectFromDecision,
  acceptProjectPlan: mocks.acceptProjectPlan,
  resolvePlanCapabilities: mocks.resolvePlanCapabilities,
  decomposeAcceptedPlan: mocks.decomposeAcceptedPlan,
}));

vi.mock("@/lib/project-control/wakeup-dispatcher", () => ({
  dispatchQueuedWakeups: mocks.dispatchQueuedWakeups,
}));

vi.mock("@/lib/hermes-execution/capabilities", () => ({
  answerCapabilityQuestion: () => ({ answer: "Build execution is available.", shape: "ready_now", matchedTools: [] }),
  getCapabilitySnapshot: mocks.getCapabilitySnapshot,
}));

import { handleProjectControlChat } from "@/lib/project-control/chat-workflow";
import { classifyWorkRequest } from "@/lib/project-control/request-classifier";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectFindFirst.mockResolvedValue(null);
  mocks.projectPlanUpdate.mockResolvedValue({});
  mocks.projectTaskCreate.mockResolvedValue({});
  mocks.dispatchQueuedWakeups.mockResolvedValue({ checked: 1, claimed: [{ wakeupId: "wakeup_1", taskId: "task_1", runId: "run_1", agentKey: "project-manager" }], skipped: [] });
});

describe("project control request classifier", () => {
  it("keeps social chat out of project creation", async () => {
    const result = await classifyWorkRequest({ message: "Hi" });

    expect(result.class).toBe("conversation");
    expect(result.isNewProject).toBe(false);
  });

  it("keeps validation and tiny UI edits on the direct execution path", async () => {
    await expect(classifyWorkRequest({ message: "Run typecheck" })).resolves.toMatchObject({
      class: "small_action",
      estimatedScope: "small",
      requiresCouncil: false,
    });
    await expect(classifyWorkRequest({ message: "Change this button color" })).resolves.toMatchObject({
      class: "small_action",
      requiresCouncil: false,
    });
  });

  it("routes project-sized build requests to the PM instead of direct build", async () => {
    const result = await classifyWorkRequest({ message: "Build me a home-construction project-manager website" });

    expect(result).toMatchObject({
      class: "project",
      isNewProject: true,
      estimatedScope: "medium",
    });
  });

  it("routes high-risk architecture work to Council first", async () => {
    const result = await classifyWorkRequest({ message: "Create a pharmacy marketplace with auth, schema, payments, and deployment" });

    expect(result.class).toBe("council_project");
    expect(result.requiresCouncil).toBe(true);
  });

  it("continues active projects instead of creating a fresh project for follow-ups", async () => {
    const result = await classifyWorkRequest({
      message: "Go ahead",
      conversationContext: { activeProjectId: "project_active", latestPlanId: "plan_1" },
    });

    expect(result).toMatchObject({
      class: "small_action",
      isExistingProjectChange: true,
      detectedProjectId: "project_active",
    });
  });
});

describe("project control chat workflow", () => {
  it("creates a proposed project plan for project-sized chat", async () => {
    mocks.createProposedProjectPlan.mockResolvedValue({
      project: { id: "project_1", projectName: "Home Construction PM Website", phase: "awaiting_plan_approval" },
      plan: {
        id: "plan_1",
        revision: 1,
        body: JSON.stringify({
          requiredCapabilities: [{ name: "local-build", type: "tool" }],
          tasks: [{ title: "Confirm project direction" }, { title: "Build first implementation" }],
        }),
      },
      proposed: {},
    });

    const result = await handleProjectControlChat({
      userId: "user_1",
      message: "Build me a home-construction project-manager website",
    });

    expect(result.handled).toBe(true);
    expect(result.projectId).toBe("project_1");
    expect(result.quickActions?.map((action) => action.id)).toContain("approve-plan");
    expect(mocks.createProposedProjectPlan).toHaveBeenCalledOnce();
    expect(mocks.dispatchQueuedWakeups).not.toHaveBeenCalled();
  });

  it("accepts the exact active plan revision, decomposes once, and dispatches wakeups", async () => {
    mocks.acceptProjectPlan.mockResolvedValue({ id: "plan_1", revision: 1 });
    mocks.resolvePlanCapabilities.mockResolvedValue({
      resolutions: [{ name: "local-build", type: "tool", state: "available", reason: "Ready." }],
      gaps: [],
    });
    mocks.decomposeAcceptedPlan.mockResolvedValue({ id: "decomp_1" });

    const result = await handleProjectControlChat({
      userId: "user_1",
      message: "project-control:approve-plan:project_1:plan_1",
    });

    expect(result.handled).toBe(true);
    expect(mocks.acceptProjectPlan).toHaveBeenCalledWith({ userId: "user_1", projectId: "project_1", planId: "plan_1" });
    expect(mocks.resolvePlanCapabilities).toHaveBeenCalledWith({ userId: "user_1", projectId: "project_1", planId: "plan_1" });
    expect(mocks.decomposeAcceptedPlan).toHaveBeenCalledWith({ userId: "user_1", projectId: "project_1", planId: "plan_1" });
    expect(mocks.dispatchQueuedWakeups).toHaveBeenCalledWith({ userId: "user_1", projectId: "project_1", limit: 4 });
  });

  it("records setup blockers for missing credentials without launching skill acquisition", async () => {
    mocks.acceptProjectPlan.mockResolvedValue({ id: "plan_1", revision: 1 });
    mocks.resolvePlanCapabilities.mockResolvedValue({
      resolutions: [{ name: "gmail", type: "credential", state: "missing_credential", reason: "Gmail is not connected." }],
      gaps: [],
    });
    mocks.decomposeAcceptedPlan.mockResolvedValue({ id: "decomp_1" });

    await handleProjectControlChat({
      userId: "user_1",
      message: "project-control:approve-plan:project_1:plan_1",
    });

    expect(mocks.projectTaskCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        title: "Setup blocker: gmail",
        status: "blocked",
        outputContract: "setup_blocker",
      }),
    }));
  });
});

describe("project control production migration", () => {
  const scriptPath = path.join(process.cwd(), "scripts", "migrate-project-control-plane.mjs");

  it("refuses unflagged local database URLs", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_ALLOW_LOCAL_MIGRATION: "", TURSO_DATABASE_URL: "file:./dev.db", TURSO_AUTH_TOKEN: "test-token" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Refusing local project-control migration");
  });

  it("accepts only explicitly flagged isolated local database URLs", () => {
    const databasePath = path.join(process.cwd(), "artifacts", "migration-flag-test.db");
    rmSync(databasePath, { force: true });
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_ALLOW_LOCAL_MIGRATION: "1", TURSO_DATABASE_URL: "file:./artifacts/migration-flag-test.db", TURSO_AUTH_TOKEN: "test-token" },
      encoding: "utf8",
    });
    rmSync(databasePath, { force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"verification": "passed"');
  });

  it("refuses unclassified remote database URLs before connecting", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, HERMES_MIGRATION_TARGET: "", TURSO_DATABASE_URL: "libsql://unproven.invalid", TURSO_AUTH_TOKEN: "test-token" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Refusing unclassified remote migration");
  });

  it("contains only additive guarded schema operations", () => {
    const content = readFileSync(scriptPath, "utf8").toLowerCase();

    expect(content).toContain("create table if not exists");
    expect(content).toContain("create index if not exists");
    expect(content).toContain("alter table");
    expect(content).not.toMatch(/\bdrop\s+table\b|\bdrop\s+column\b|\brename\s+table\b|\baccept-data-loss\b/);
  });
});
