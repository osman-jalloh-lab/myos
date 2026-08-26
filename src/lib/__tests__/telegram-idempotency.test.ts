import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Durable Telegram update_id idempotency ──────────────────────────────────
// No in-memory Set here — every claim/duplicate/retry decision hits the mocked
// TelegramUpdate table, mirroring the durability requirement (must survive a
// serverless function restart). The stale-processing reclaim path uses raw SQL
// (see telegram-idempotency.ts for why) — these mocks stand in for it, but the
// authoritative proof it works is the real-SQLite verification run manually
// during the pre-migration safety review (see that report): a Date-equality
// CAS looked correct in mocks just like this but silently matched zero rows
// against the real libsql adapter, including for a solo, non-concurrent call.

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramUpdate: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
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

  it("reports duplicate for a callback still processing and fresh (double-tap Approve Plan)", async () => {
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
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("allows retry when a prior attempt failed — status-transition CAS, no raw SQL needed", async () => {
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

  it("re-reads and reports duplicate when the failed-retry race is lost", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique)
      .mockResolvedValueOnce({
        id: "row_3b", updateId: 3004, updateType: "voice", status: "failed",
        resultNote: null, createdAt: new Date(), updatedAt: new Date(),
      } as never)
      .mockResolvedValueOnce({
        // Second read (after losing the race): the winner already flipped it to processing.
        id: "row_3b", updateId: 3004, updateType: "voice", status: "processing",
        resultNote: null, createdAt: new Date(), updatedAt: new Date(),
      } as never);
    vi.mocked(prisma.telegramUpdate.updateMany).mockResolvedValue({ count: 0 }); // lost the race

    const result = await claimTelegramUpdate(3004, "voice");

    expect(result.outcome).toBe("duplicate");
  });

  it("allows retry when a prior 'processing' claim is stale (crashed mid-flight) — via raw SQL freshness window", async () => {
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
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1);

    const result = await claimTelegramUpdate(4004, "message");

    expect(result.outcome).toBe("claimed");
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("WHERE updateId = ? AND status = 'processing'"),
      4004,
      "-300 seconds"
    );
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

// ── Pre-migration safety review: race behavior (scenarios A-E) ─────────────
// These exercise claimTelegramUpdate's decision logic under the exact
// concurrency shapes a real Vercel retry or double invocation can produce.
// Scenario E in particular is the one that caught a real bug during review:
// the first version of the stale-processing reclaim used a Date-equality CAS
// that looked correct here (mocks don't validate real serialization) but
// matched zero rows against the actual libsql/sqlite adapter — confirmed by
// running claimTelegramUpdate against a disposable local SQLite file. The
// fixed implementation (raw-SQL freshness window) was re-verified the same
// way before these mocked tests were finalized.
describe("race behavior — compare-and-swap safety", () => {
  it("A: first invocation claims, a concurrent second invocation cannot process", async () => {
    // Real DB: the unique index on updateId makes this atomic — only one
    // INSERT can succeed. Model that directly: first create() resolves,
    // the concurrent second create() hits the unique constraint.
    vi.mocked(prisma.telegramUpdate.create)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_a", updateId: 6001, updateType: "message", status: "processing",
      resultNote: null, createdAt: new Date(), updatedAt: new Date(),
    } as never);

    const [first, second] = await Promise.all([
      claimTelegramUpdate(6001, "message"),
      claimTelegramUpdate(6001, "message"),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["claimed", "duplicate"]);
  });

  it("B: a crash mid-processing leaves a stale claim that a later invocation safely reclaims exactly once", async () => {
    const crashedAt = new Date(Date.now() - 10 * 60 * 1000);
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_b", updateId: 6002, updateType: "message", status: "processing",
      resultNote: null, createdAt: crashedAt, updatedAt: crashedAt,
    } as never);
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1);
    vi.mocked(prisma.telegramUpdate.update).mockResolvedValue({} as never);

    const result = await claimTelegramUpdate(6002, "message");

    expect(result.outcome).toBe("claimed");
    await completeTelegramUpdate(6002, "processed after reclaim");
    expect(prisma.telegramUpdate.update).toHaveBeenCalledWith({
      where: { updateId: 6002 },
      data: { status: "completed", resultNote: "processed after reclaim" },
    });
  });

  it("C: a completed update received again never processes — permanent duplicate", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_c", updateId: 6003, updateType: "message", status: "completed",
      resultNote: "text: routed", createdAt: new Date(), updatedAt: new Date(),
    } as never);

    const result = await claimTelegramUpdate(6003, "message");

    expect(result).toEqual({ outcome: "duplicate", status: "completed", resultNote: "text: routed" });
    expect(prisma.telegramUpdate.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("D: a failed update can be retried per policy (no cap needed — Telegram never redelivers a 200'd update, so this only fires on deliberate reprocessing)", async () => {
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    vi.mocked(prisma.telegramUpdate.findUnique).mockResolvedValue({
      id: "row_d", updateId: 6004, updateType: "voice", status: "failed",
      resultNote: "transcription failed", createdAt: new Date(), updatedAt: new Date(),
    } as never);
    vi.mocked(prisma.telegramUpdate.updateMany).mockResolvedValue({ count: 1 });

    const result = await claimTelegramUpdate(6004, "voice");

    expect(result.outcome).toBe("claimed");
  });

  it("E: two stale-reclaim attempts race — only one wins, the loser re-reads fresh state instead of retrying forever", async () => {
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    const freshAt = new Date();
    const staleRow = { id: "row_e", updateId: 6005, updateType: "message", status: "processing", resultNote: null, createdAt: staleAt, updatedAt: staleAt };
    const freshRow = { ...staleRow, updatedAt: freshAt };
    vi.mocked(prisma.telegramUpdate.create).mockRejectedValue(uniqueConstraintError());
    // Read order simulated: A's read (stale), B's read (also stale — genuinely
    // concurrent, both read before either writes), then B's post-loss retry
    // read sees what A's write just committed: "processing" but fresh.
    vi.mocked(prisma.telegramUpdate.findUnique)
      .mockResolvedValueOnce(staleRow as never)  // A's read
      .mockResolvedValueOnce(staleRow as never)  // B's read
      .mockResolvedValueOnce(freshRow as never); // B's retry read after losing
    // Simulates the real DB: an UPDATE ... WHERE status='processing' AND
    // updatedAt <= <cutoff computed at execution time> matches at most once —
    // the winner's write sets updatedAt to "now", so a second identical
    // statement (evaluated after the winner commits) no longer sees a stale
    // row and affects zero rows.
    vi.mocked(prisma.$executeRawUnsafe)
      .mockResolvedValueOnce(1) // A wins
      .mockResolvedValueOnce(0); // B loses the CAS

    const winner = await claimTelegramUpdate(6005, "message"); // A
    const loser = await claimTelegramUpdate(6005, "message");  // B

    expect(winner.outcome).toBe("claimed");
    expect(loser.outcome).toBe("duplicate"); // re-read fresh state — did not spin retrying
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2); // exactly one reclaim attempt each, no unbounded retry loop
    expect(prisma.telegramUpdate.findUnique).toHaveBeenCalledTimes(3);
  });
});
