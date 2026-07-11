import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRegistryInitialized: vi.fn(async () => undefined),
  listTools: vi.fn(),
  getLocalWorkerLiveness: vi.fn(),
  getHermesAgentReadiness: vi.fn(),
}));

vi.mock("@/lib/hermes-execution/tool-registry", () => ({
  ensureRegistryInitialized: mocks.ensureRegistryInitialized,
  listTools: mocks.listTools,
}));

vi.mock("@/lib/worker-watch", () => ({
  getLocalWorkerLiveness: mocks.getLocalWorkerLiveness,
  getHermesAgentReadiness: mocks.getHermesAgentReadiness,
}));

import { answerCapabilityQuestion, getCapabilitySnapshot, type CapabilitySnapshot } from "@/lib/hermes-execution/capabilities";

function snapshot(overrides: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot {
  return {
    generatedAt: "2026-07-11T18:00:00.000Z",
    tools: [
      {
        name: "internal.code.buildFeature",
        description: "Build feature code.",
        risk: "internal_write",
        requiresApproval: false,
      },
      {
        name: "internal.email.createDraft",
        description: "Queue an email draft.",
        risk: "external_write",
        requiresApproval: true,
      },
    ],
    toolCounts: { total: 2, read: 0, internalWrite: 1, externalWrite: 1, approvalRequired: 1 },
    worker: {
      status: "online",
      lastHeartbeat: "2026-07-11T18:00:00.000Z",
      machineName: "HP",
      ageMs: 1000,
      currentTask: null,
    },
    hermesAgent: { ready: true, reason: null },
    buildExecution: {
      available: true,
      executor: "hermes_agent",
      reason: "Local worker is online and Hermes Nous is ready.",
    },
    ...overrides,
  };
}

describe("capability snapshot", () => {
  it("reflects the real tool registry and worker health sources", async () => {
    mocks.listTools.mockReturnValue([
      {
        name: "internal.chat.respond",
        description: "Fallback chat.",
        risk: "read",
        requiresApproval: false,
        execute: vi.fn(),
      },
      {
        name: "internal.projects.requestHandoff",
        description: "Queue a handoff.",
        risk: "external_write",
        requiresApproval: true,
        execute: vi.fn(),
      },
    ]);
    mocks.getLocalWorkerLiveness.mockResolvedValue({
      status: "online",
      lastHeartbeat: "2026-07-11T18:00:00.000Z",
      machineName: "HP",
      ageMs: 1000,
      currentTask: "idle",
    });
    mocks.getHermesAgentReadiness.mockResolvedValue({ ready: true, reason: null });

    const snapshot = await getCapabilitySnapshot();

    expect(mocks.ensureRegistryInitialized).toHaveBeenCalledOnce();
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "internal.chat.respond",
      "internal.projects.requestHandoff",
    ]);
    expect(snapshot.toolCounts).toMatchObject({
      total: 2,
      read: 1,
      externalWrite: 1,
      approvalRequired: 1,
    });
    expect(snapshot.worker.status).toBe("online");
    expect(snapshot.buildExecution).toEqual({
      available: true,
      executor: "hermes_agent",
      reason: "Local worker is online and Hermes Nous is ready.",
    });
  });

  it("does not claim build execution when the worker is offline", async () => {
    mocks.listTools.mockReturnValue([]);
    mocks.getLocalWorkerLiveness.mockResolvedValue({
      status: "offline",
      lastHeartbeat: "2026-07-11T17:00:00.000Z",
      machineName: "HP",
      ageMs: 120000,
      currentTask: null,
    });
    mocks.getHermesAgentReadiness.mockResolvedValue({ ready: false, reason: "Hermes Nous is not installed" });

    const snapshot = await getCapabilitySnapshot();

    expect(snapshot.buildExecution.available).toBe(false);
    expect(snapshot.buildExecution.executor).toBeNull();
    expect(snapshot.buildExecution.reason).toContain("offline");
  });

  it("answers build capability as ready when worker execution is available", () => {
    const result = answerCapabilityQuestion("Can you build a page and deploy it?", snapshot());

    expect(result.shape).toBe("ready_now");
    expect(result.answer).toContain("approval gates");
    expect(result.matchedTools).toContain("internal.code.buildFeature");
  });

  it("answers build capability as queue-only when the worker is unavailable", () => {
    const result = answerCapabilityQuestion("Can you build a page?", snapshot({
      worker: { status: "offline", lastHeartbeat: null, machineName: null, ageMs: null, currentTask: null },
      hermesAgent: { ready: false, reason: "no local worker" },
      buildExecution: { available: false, executor: null, reason: "Local worker is offline." },
    }));

    expect(result.shape).toBe("queue_only");
    expect(result.answer).toContain("cannot honestly say it is building");
  });

  it("answers write capability as approval/setup-needed when the matching tool is gated", () => {
    const result = answerCapabilityQuestion("Can you send this email?", snapshot());

    expect(result.shape).toBe("needs_setup");
    expect(result.answer).toContain("requires approval");
    expect(result.matchedTools).toContain("internal.email.createDraft");
  });

  it("answers unsupported when no registered capability matches", () => {
    const result = answerCapabilityQuestion("Can you trade stocks for me?", snapshot({ tools: [] }));

    expect(result.shape).toBe("unsupported");
    expect(result.answer).not.toMatch(/\bcan do that\b/i);
  });
});
