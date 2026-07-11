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

import { getCapabilitySnapshot } from "@/lib/hermes-execution/capabilities";

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
});
