import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Approval queue unit tests ──────────────────────────────────────────────────
// Tests the pure logic in approvals.ts without hitting Turso.
// We mock prisma so no real DB connection is needed.

vi.mock("@/lib/db", () => ({
  prisma: {
    approvalAction: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    task: { create: vi.fn() },
    memory: { create: vi.fn(), deleteMany: vi.fn() },
    financeEntry: { create: vi.fn() },
    jobListing: { create: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { approveAction, rejectAction, createApproval, markApprovalAwaitingRevision, findApprovalAwaitingRevision, supersedeApproval } from "@/lib/approvals";

const MOCK_PENDING_ROW = {
  id: "act_1",
  userId: "user_1",
  actionType: "create_task",
  payload: JSON.stringify({ title: "Test task" }),
  status: "pending",
  createdAt: new Date("2026-06-18T00:00:00Z"),
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveAction", () => {
  it("throws when action is not pending", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      status: "approved",
    });

    await expect(approveAction("user_1", "act_1")).rejects.toThrow("already approved");
  });

  it("updates to approved and executes create_task immediately", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue(MOCK_PENDING_ROW);
    vi.mocked(prisma.approvalAction.update).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      status: "executed",
      resolvedAt: new Date(),
    });
    vi.mocked(prisma.task.create).mockResolvedValue({ id: "task_1" } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue(undefined as never);

    const result = await approveAction("user_1", "act_1");

    expect(prisma.task.create).toHaveBeenCalledOnce();
    expect(result.status).toBe("executed");
  });

  it("writes an audit log entry on success", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue(MOCK_PENDING_ROW);
    vi.mocked(prisma.approvalAction.update).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      status: "executed",
      resolvedAt: new Date(),
    });
    vi.mocked(prisma.task.create).mockResolvedValue({ id: "task_1" } as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue(undefined as never);

    await approveAction("user_1", "act_1");

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "approved", resourceType: "ApprovalAction" }),
      })
    );
  });
});

describe("rejectAction", () => {
  it("updates status to rejected", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue(MOCK_PENDING_ROW);
    vi.mocked(prisma.approvalAction.update).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      status: "rejected",
      resolvedAt: new Date(),
    });
    vi.mocked(prisma.auditLog.create).mockResolvedValue(undefined as never);

    const result = await rejectAction("user_1", "act_1");

    expect(result.status).toBe("rejected");
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "rejected" }),
      })
    );
  });

  it("throws when action is already rejected", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      status: "rejected",
    });

    await expect(rejectAction("user_1", "act_1")).rejects.toThrow("already rejected");
  });
});

describe("createApproval", () => {
  it("deduplicates identical pending actions", async () => {
    const existing = { ...MOCK_PENDING_ROW, actionType: "create_task" };
    vi.mocked(prisma.approvalAction.findFirst).mockResolvedValue(existing);

    const result = await createApproval("user_1", "create_task", { title: "Test task" });

    expect(prisma.approvalAction.create).not.toHaveBeenCalled();
    expect(result.id).toBe("act_1");
  });

  it("creates a new action when none exists", async () => {
    vi.mocked(prisma.approvalAction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.approvalAction.create).mockResolvedValue({
      ...MOCK_PENDING_ROW,
      id: "act_new",
    });

    const result = await createApproval("user_1", "create_task", { title: "New task" });

    expect(prisma.approvalAction.create).toHaveBeenCalledOnce();
    expect(result.id).toBe("act_new");
  });
});

// ── Minimal plan-revision state (Telegram "Revise") ─────────────────────────
const MOCK_PLAN_ROW = {
  id: "plan_1",
  userId: "user_1",
  actionType: "engineering_plan",
  payload: JSON.stringify({ objective: "build a landing page" }),
  status: "pending",
  createdAt: new Date("2026-08-25T00:00:00Z"),
  resolvedAt: null,
};

describe("markApprovalAwaitingRevision", () => {
  it("flags the payload without changing status", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue(MOCK_PLAN_ROW);
    vi.mocked(prisma.approvalAction.update).mockResolvedValue(MOCK_PLAN_ROW);

    await markApprovalAwaitingRevision("user_1", "plan_1");

    expect(prisma.approvalAction.update).toHaveBeenCalledWith({
      where: { id: "plan_1" },
      data: { payload: JSON.stringify({ objective: "build a landing page", awaitingRevision: true }) },
    });
  });

  it("throws if the plan is no longer pending — can't revise an already-resolved plan", async () => {
    vi.mocked(prisma.approvalAction.findFirstOrThrow).mockResolvedValue({ ...MOCK_PLAN_ROW, status: "approved" });

    await expect(markApprovalAwaitingRevision("user_1", "plan_1")).rejects.toThrow("already approved");
  });
});

describe("findApprovalAwaitingRevision", () => {
  it("finds the pending engineering_plan row flagged awaitingRevision", async () => {
    vi.mocked(prisma.approvalAction.findMany).mockResolvedValue([
      { ...MOCK_PLAN_ROW, id: "plan_old", payload: JSON.stringify({ objective: "old" }) },
      { ...MOCK_PLAN_ROW, id: "plan_flagged", payload: JSON.stringify({ objective: "build a landing page", awaitingRevision: true }) },
    ]);

    const result = await findApprovalAwaitingRevision("user_1");

    expect(result?.id).toBe("plan_flagged");
  });

  it("returns null when nothing is awaiting revision", async () => {
    vi.mocked(prisma.approvalAction.findMany).mockResolvedValue([MOCK_PLAN_ROW]);

    const result = await findApprovalAwaitingRevision("user_1");

    expect(result).toBeNull();
  });
});

describe("supersedeApproval", () => {
  it("rejects the pending row so the original plan can never be approved again", async () => {
    vi.mocked(prisma.approvalAction.findFirst).mockResolvedValue(MOCK_PLAN_ROW);
    vi.mocked(prisma.approvalAction.update).mockResolvedValue({ ...MOCK_PLAN_ROW, status: "rejected" });
    vi.mocked(prisma.auditLog.create).mockResolvedValue(undefined as never);

    await supersedeApproval("user_1", "plan_1");

    expect(prisma.approvalAction.update).toHaveBeenCalledWith({
      where: { id: "plan_1" },
      data: { status: "rejected", resolvedAt: expect.any(Date) },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "superseded_by_revision" }) })
    );
  });

  it("is a no-op if the plan is already resolved — never overwrites a real approve/reject", async () => {
    vi.mocked(prisma.approvalAction.findFirst).mockResolvedValue(null); // findFirst filters status: "pending"

    await supersedeApproval("user_1", "plan_1");

    expect(prisma.approvalAction.update).not.toHaveBeenCalled();
  });
});
