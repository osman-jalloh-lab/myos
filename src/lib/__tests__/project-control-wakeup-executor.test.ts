import { beforeEach, describe, expect, it, vi } from "vitest";

const baseTime = new Date("2026-07-12T12:00:00.000Z");

type TestRow = Record<string, unknown>;
type TestState = {
  wakeup: TestRow | null;
  project: TestRow | null;
  task: TestRow | null;
  run: TestRow | null;
  plan: TestRow | null;
  dependencies: TestRow[];
  tasks: TestRow[];
  artifacts: TestRow[];
  events: TestRow[];
  updates: Array<[string, unknown]>;
};

const state = vi.hoisted(() => ({
  wakeup: null,
  project: null,
  task: null,
  run: null,
  plan: null,
  dependencies: [],
  tasks: [],
  artifacts: [],
  events: [],
  updates: [],
}) as TestState);

vi.mock("@/lib/db", () => ({
  prisma: {
    agentWakeup: {
      findUnique: vi.fn(async () => state.wakeup),
      findFirstOrThrow: vi.fn(async () => state.wakeup),
      upsert: vi.fn(async ({ create, update }) => {
        if (state.wakeup?.idempotencyKey === create.idempotencyKey) {
          state.wakeup = { ...state.wakeup, ...update };
          return state.wakeup;
        }
        const row = { id: `wakeup_${Date.now()}`, ...create, createdAt: baseTime, updatedAt: baseTime };
        state.updates.push(["wakeup-upsert", row]);
        return row;
      }),
      update: vi.fn(async ({ data }) => {
        state.wakeup = { ...state.wakeup, ...data };
        state.updates.push(["wakeup", data]);
        return state.wakeup;
      }),
    },
    project: {
      findUnique: vi.fn(async () => state.project),
      findUniqueOrThrow: vi.fn(async () => state.project),
      findFirstOrThrow: vi.fn(async () => state.project),
      update: vi.fn(async ({ data }) => {
        state.project = { ...state.project, ...data };
        state.updates.push(["project", data]);
        return state.project;
      }),
    },
    projectTask: {
      findUnique: vi.fn(async ({ where }) => state.tasks.find((task) => task.id === where.id) ?? state.task),
      findUniqueOrThrow: vi.fn(async () => state.task),
      findMany: vi.fn(async ({ where } = {}) => {
        let rows = [...state.tasks];
        if (where?.projectId) rows = rows.filter((task) => task.projectId === where.projectId || !task.projectId);
        if (where?.status?.in) rows = rows.filter((task) => where.status.in.includes(task.status));
        if (where?.status?.not) rows = rows.filter((task) => task.status !== where.status.not);
        if (where?.id?.in) rows = rows.filter((task) => where.id.in.includes(task.id));
        return rows;
      }),
      create: vi.fn(async ({ data }) => {
        const created = { id: `task_${state.tasks.length + 1}`, ...data, createdAt: baseTime, updatedAt: baseTime };
        state.tasks.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }) => {
        const target = state.tasks.find((task) => task.id === where.id) ?? state.task;
        if (!target) throw new Error("No task in test state.");
        Object.assign(target, data, { updatedAt: baseTime });
        if (state.task && target.id === state.task.id) state.task = target;
        state.updates.push(["task", data]);
        return target;
      }),
    },
    executionRun: {
      findUnique: vi.fn(async () => state.run),
      update: vi.fn(async ({ data }) => {
        state.run = { ...state.run, ...data };
        state.updates.push(["run", data]);
        return state.run;
      }),
    },
    projectPlan: {
      findFirst: vi.fn(async () => state.plan),
    },
    projectTaskDependency: {
      findMany: vi.fn(async () => state.dependencies),
    },
    projectTaskArtifact: {
      findMany: vi.fn(async () => state.artifacts),
      create: vi.fn(async ({ data }) => {
        const row = { id: `artifact_${state.artifacts.length + 1}`, ...data, createdAt: baseTime };
        state.artifacts.push(row);
        return row;
      }),
    },
    capabilityGap: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/execution-runs", () => ({
  appendExecutionEvent: vi.fn(async (runId, event) => {
    state.events.push({ runId, ...event });
    return { id: `event_${state.events.length}`, runId, createdAt: baseTime.toISOString(), ...event };
  }),
  redactExecutionText: (value: unknown, max = 2000) => (typeof value === "string" ? value : JSON.stringify(value ?? "")).slice(0, max),
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: vi.fn(async () => ({ id: "approval_1" })),
}));

vi.mock("@/lib/skills/registry", () => ({
  getRegisteredSkills: vi.fn(async () => [
    {
      id: "project-starter",
      name: "Project Starter",
      enabled: true,
      ownerAgents: ["project-manager", "prometheus", "sophos", "argus", "fugu"],
      safetyClass: "read_only",
      executionTool: null,
    },
  ]),
}));

import { evaluateAcceptanceCriteria } from "@/lib/project-control/acceptance-evaluator";
import { executeClaimedWakeup } from "@/lib/project-control/wakeup-executor";

function resetState(overrides: Partial<typeof state> = {}) {
  state.project = {
    id: "project_1",
    userId: "user_1",
    projectName: "Hermes OS Control Plane",
    description: "Work in the existing Hermes OS repository.",
    latestInstruction: "Build this feature in Hermes OS.",
    status: "ready",
    phase: "ready",
    localFolderPath: null,
  };
  state.task = {
    id: "task_1",
    projectId: "project_1",
    userId: "user_1",
    title: "Build control plane feature",
    description: "Implement the next feature.",
    status: "running",
    assignedAgent: "prometheus",
    activeRunId: "run_1",
    acceptanceCriteria: "Implementation artifact produced.",
    outputContract: "build_result",
    requiredCapabilities: JSON.stringify([{ name: "local-build", type: "tool" }]),
    nextStep: null,
    completedAt: null,
    updatedAt: baseTime,
  };
  state.tasks = [state.task];
  state.wakeup = {
    id: "wakeup_1",
    userId: "user_1",
    projectId: "project_1",
    projectTaskId: "task_1",
    agentKey: "prometheus",
    status: "claimed",
    runId: "run_1",
  };
  state.run = { id: "run_1", userId: "user_1", projectId: "project_1", taskId: "task_1", status: "running" };
  state.plan = { id: "plan_1", projectId: "project_1", revision: 1, status: "accepted" };
  state.dependencies = [];
  state.artifacts = [];
  state.events = [];
  state.updates = [];
  Object.assign(state, overrides);
}

beforeEach(() => resetState());

function task(): TestRow {
  if (!state.task) throw new Error("Expected task in test state.");
  return state.task;
}

function project(): TestRow {
  if (!state.project) throw new Error("Expected project in test state.");
  return state.project;
}

function wakeup(): TestRow {
  if (!state.wakeup) throw new Error("Expected wakeup in test state.");
  return state.wakeup;
}

function hasPlanId(event: TestRow): boolean {
  const details = event.safeDetails;
  return Boolean(details && typeof details === "object" && "planId" in details && details.planId === "plan_1");
}

describe("project control wakeup executor", () => {
  it("invokes the Prometheus adapter with the accepted plan revision and persists linked artifacts", async () => {
    const outcome = await executeClaimedWakeup("wakeup_1");

    expect(outcome.status).toBe("completed");
    expect(outcome.artifactIds.length).toBeGreaterThan(0);
    expect(state.artifacts[0]).toMatchObject({
      projectId: "project_1",
      projectTaskId: "task_1",
      executionRunId: "run_1",
      wakeupId: "wakeup_1",
      agentKey: "prometheus",
    });
    expect(state.events.some(hasPlanId)).toBe(true);
    expect(task().status).toBe("completed");
  });

  it("does not execute cancelled tasks", async () => {
    task().status = "cancelled";

    const outcome = await executeClaimedWakeup("wakeup_1");

    expect(outcome.status).toBe("skipped");
    expect(state.artifacts).toHaveLength(0);
    expect(wakeup().status).toBe("skipped");
  });

  it("does not execute when blockers reopened", async () => {
    state.dependencies = [{ projectId: "project_1", taskId: "task_1", blockingTaskId: "task_blocker" }];
    state.tasks.push({ id: "task_blocker", status: "running", title: "Blocker", completedAt: null, nextStep: null });

    const outcome = await executeClaimedWakeup("wakeup_1");

    expect(outcome.status).toBe("blocked");
    expect(task().status).toBe("blocked");
    expect(String(task().blockedReason)).toContain("blockers");
  });

  it("blocks Prometheus code work when no approved workspace exists", async () => {
    project().projectName = "New external site";
    project().description = "No workspace attached.";
    project().latestInstruction = "Build a new site.";

    const outcome = await executeClaimedWakeup("wakeup_1");

    expect(outcome.status).toBe("blocked");
    expect(task().status).toBe("blocked");
    expect(state.artifacts[0].artifactType).toBe("completion_report");
  });

  it("does not pass acceptance criteria without durable evidence", () => {
    const result = evaluateAcceptanceCriteria({
      criteria: ["Build artifact exists."],
      outputContract: "build_result",
      evidence: [],
      artifactIds: [],
      status: "completed",
    });

    expect(result.complete).toBe(false);
    expect(result.results[0].status).toBe("not_proven");
  });
});
