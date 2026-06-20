import { describe, it, expect } from "vitest";
import { realityCheck, formatTaskStateReply } from "@/lib/realityCheck";

describe("realityCheck", () => {
  it("returns uncertain when source is 'none'", () => {
    const result = realityCheck({ claim: "Task completed", evidence: null, source: "none" });
    expect(result.status).toBe("uncertain");
    expect(result.safeClaim).toBe("I don't have evidence that this ran yet.");
    expect(result.missingEvidence).toBeTruthy();
  });

  it("returns uncertain when evidence is null even with a real source", () => {
    const result = realityCheck({ claim: "Task completed", evidence: null, source: "AgentTask" });
    expect(result.status).toBe("uncertain");
  });

  it("returns blocked when source is approval_queue", () => {
    const result = realityCheck({
      claim: "Task completed",
      evidence: { status: "approved" },
      source: "approval_queue",
    });
    expect(result.status).toBe("blocked");
    expect(result.safeClaim).toContain("approval queue");
  });

  it("returns verified for a done AgentTask record", () => {
    const result = realityCheck({
      claim: "Deploy finished",
      evidence: { id: "task_1", status: "done" },
      source: "AgentTask",
    });
    expect(result.status).toBe("verified");
    expect(result.safeClaim).toBe("Deploy finished");
  });

  it("returns verified for a completed AgentRun record", () => {
    const result = realityCheck({
      claim: "Cron ran",
      evidence: { id: "run_1", status: "completed" },
      source: "AgentRun",
    });
    expect(result.status).toBe("verified");
  });

  it("returns inferred for an in_progress task", () => {
    const result = realityCheck({
      claim: "Task is running",
      evidence: { id: "task_1", status: "in_progress" },
      source: "AgentTask",
    });
    expect(result.status).toBe("inferred");
    expect(result.safeClaim).toContain("in progress");
  });

  it("returns verified with failure status when task failed", () => {
    const result = realityCheck({
      claim: "Build succeeded",
      evidence: { id: "run_1", status: "failed" },
      source: "AgentRun",
    });
    expect(result.status).toBe("verified");
    expect(result.safeClaim).toContain("failed");
  });
});

describe("formatTaskStateReply", () => {
  it("returns no-record message when both tables are empty", () => {
    const reply = formatTaskStateReply({
      hasTasks: false,
      recentTasks: [],
      recentRuns: [],
      pendingCount: 0,
      doneCount: 0,
      failedCount: 0,
    });
    expect(reply).toContain("don't have a task record");
    expect(reply).not.toContain("clean");
    expect(reply).not.toContain("no issues");
    expect(reply).not.toContain("shipped");
  });

  it("lists tasks when records exist", () => {
    const reply = formatTaskStateReply({
      hasTasks: true,
      recentTasks: [
        {
          id: "t1",
          title: "Build the feature",
          status: "done",
          assignedAgent: "prometheus",
          resolvedAt: "2026-06-18T12:00:00.000Z",
          createdAt: "2026-06-18T11:00:00.000Z",
        },
      ],
      recentRuns: [],
      pendingCount: 0,
      doneCount: 1,
      failedCount: 0,
    });
    expect(reply).toContain("DONE");
    expect(reply).toContain("Build the feature");
    expect(reply).toContain("prometheus");
  });

  it("never says 'no pending approvals' as the entire reply", () => {
    const reply = formatTaskStateReply({
      hasTasks: false,
      recentTasks: [],
      recentRuns: [],
      pendingCount: 0,
      doneCount: 0,
      failedCount: 0,
    });
    expect(reply).not.toBe("No pending approvals right now.");
    expect(reply).not.toMatch(/^No pending/);
  });

  it("includes failed run count in summary", () => {
    const reply = formatTaskStateReply({
      hasTasks: true,
      recentTasks: [
        {
          id: "t1",
          title: "Deploy",
          status: "in_progress",
          assignedAgent: null,
          resolvedAt: null,
          createdAt: "2026-06-18T11:00:00.000Z",
        },
      ],
      recentRuns: [
        {
          id: "r1",
          agentName: "hermes-execution",
          status: "failed",
          inputSummary: "deploy task",
          outputSummary: "error: timeout",
          createdAt: "2026-06-18T11:05:00.000Z",
        },
      ],
      pendingCount: 1,
      doneCount: 0,
      failedCount: 1,
    });
    expect(reply).toContain("1 failed runs");
    expect(reply).toContain("1 pending");
  });
});
