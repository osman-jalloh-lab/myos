import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Durable Telegram update_id idempotency ──────────────────────────────────
// No in-memory Set here — every claim/duplicate/retry decision hits the mocked
// TelegramUpdate table, mirroring the durability requirement (must survive a
// serverless function restart).

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramUpdate: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from "@/lib/telegram-idempotency";

function uniqueConstraintError() {
  const err = new Error("Unique constraint failed") as Error & { code: string };
  err.code = "P2002";
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimTelegramUpdate", () => {
  it("claims a fresh update_id", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockResolvedValue({} as never);

    const result = await claimTelegramUpdate(1001, "message");

    expect(result.outcome).toBe("claimed");
    expect(prisma.telegramUpdate.create).toHaveBeenCalledWith({
      data: { updateId: 1001, updateType: "message", status: "processing" },
    });
  });

  it("reports duplicate for an already-completed update_id — no re-run", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_1",
      updateId: 1001,
      updateType: "message",
      status: "completed",
      resultNote: "text: routed",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await claimTelegramUpdate(1001, "message");

    expect(result).toEqual({ outcome: "duplicate", status: "completed", resultNote: "text: routed" });
  });

  it("reports duplicate for a callback still processing (double-tap Approve Plan)", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_2",
      updateId: 2002,
      updateType: "callback_query",
      status: "processing",
      resultNote: null,
      createdAt: new Date(),
      updatedAt: new Date(), // fresh — not stale
    } as never);

    const result = await claimTelegramUpdate(2002, "callback_query");

    expect(result.outcome).toBe("duplicate");
    expect(prisma.telegramUpdate.updateMany).not.toHaveBeenCalled();
  });

  it("allows retry when a prior attempt failed", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_3",
      updateId: 3003,
      updateType: "voice",
      status: "failed",
      resultNote: "transcription failed",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(prisma.telegramUpdate.updateMany).mockResolvedValue({ count: 1 });

    const result = await claimTelegramUpdate(3003, "voice");

    expect(result.outcome).toBe("claimed");
    expect(prisma.telegramUpdate.updateMany).toHaveBeenCalledWith({
      where: { updateId: 3003, status: "failed" },
      data: { status: "processing", resultNote: null },
    });
  });

  it("allows retry when a prior 'processing' claim is stale (crashed mid-flight)", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_4",
      updateId: 4004,
      updateType: "message",
      status: "processing",
      resultNote: null,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      updatedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes old — past the stale threshold
    } as never);
    vi.mocked(prisma.telegramUpdate.updateMany).mockResolvedValue({ count: 1 });

    const result = await claimTelegramUpdate(4004, "message");

    expect(result.outcome).toBe("claimed");
  });

  it("propagates non-unique-constraint errors instead of swallowing them", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(new Error("connection reset"));

    await expect(claimTelegramUpdate(5005, "message")).rejects.toThrow("connection reset");
  });
});

describe("completeTelegramUpdate / failTelegramUpdate", () => {
  it("marks an update completed with a result note", async () => {
    vi.mocked(prisma.telegramUpdate.update).mockResolvedValue({} as never);

    await completeTelegramUpdate(1001, "text: routed");

    expect(prisma.telegramUpdate.update).toHaveBeenCalledWith({
      where: { updateId: 1001 },
      data: { status: "completed", resultNote: "text: routed" },
    });
  });

  it("marks an update failed without throwing even if the write itself fails", async () => {
    vi.mocked(prisma.telegramUpdate.update).mockRejectedValue(new Error("db unavailable"));

    await expect(failTelegramUpdate(1001, "boom")).resolves.toBeUndefined();
  });
});
