// Durable dedupe for inbound Telegram updates. Telegram retries undelivered
// webhooks and Vercel can retry a function invocation, so update_id must be
// claimed in the database before any Hermes routing, approval, or execution
// work starts. An in-memory Set does not survive a serverless cold start.
import { prisma } from "@/lib/db";

export type TelegramUpdateType = "message" | "voice" | "audio" | "callback_query";

// A "processing" claim older than this is assumed to have crashed mid-flight
// (e.g. function timeout) rather than still be in progress — allow retry
// instead of losing the update forever.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export type ClaimResult =
  | { outcome: "claimed" }
  | { outcome: "duplicate"; status: string; resultNote: string | null };

/**
 * Attempts to claim an update_id for processing. Returns "claimed" exactly
 * once per update_id (until a stale/failed retry is explicitly allowed), and
 * "duplicate" for every retry after that — the caller should skip re-running
 * Hermes routing, approvals, or execution for a "duplicate" result.
 */
export async function claimTelegramUpdate(updateId: number, updateType: TelegramUpdateType): Promise<ClaimResult> {
  try {
    await prisma.telegramUpdate.create({
      data: { updateId, updateType, status: "processing" },
    });
    return { outcome: "claimed" };
  } catch (error) {
    // P2002 = unique constraint violation on updateId — someone already claimed it.
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing = await prisma.telegramUpdate.findUnique({ where: { updateId } });
  if (!existing) {
    // Raced with a delete or the row vanished — treat as claimable.
    return claimTelegramUpdate(updateId, updateType);
  }

  if (existing.status === "failed") {
    // status genuinely transitions failed -> processing, so a plain
    // conditional UPDATE ... WHERE status='failed' is already a safe
    // single-winner CAS: SQLite/libSQL executes each UPDATE as one atomic
    // statement, so once the winner flips the row's status, a racer's WHERE
    // stops matching it — no value-equality comparison needed.
    const reclaimed = await prisma.telegramUpdate.updateMany({
      where: { updateId, status: "failed" },
      data: { status: "processing", resultNote: null },
    });
    if (reclaimed.count > 0) return { outcome: "claimed" };
    // Lost the race (someone else reclaimed it first) — re-read fresh state.
    return claimTelegramUpdate(updateId, updateType);
  }

  if (existing.status === "processing" && Date.now() - existing.updatedAt.getTime() > STALE_PROCESSING_MS) {
    // Stale-processing reclaim: old and new status are BOTH "processing", so a
    // status-only WHERE can't tell winner from loser. Comparing the WHERE
    // clause against the exact updatedAt Date object just read (an earlier
    // version of this function did that) is NOT reliable here — empirically
    // verified against the real libsql/sqlite adapter that a Date value bound
    // as a query parameter does not round-trip to match the stored ISO8601
    // string byte-for-byte, so that "CAS" silently matched zero rows every
    // time, including non-concurrent calls. Recomputing the staleness cutoff
    // directly in SQL avoids the round-trip entirely: only a row still older
    // than "now - STALE_PROCESSING_MS" AT THE MOMENT THIS STATEMENT RUNS
    // matches. The winner's write sets updatedAt to "now", so a concurrent
    // racer's identical statement — applied after the winner's commits —
    // no longer sees a stale row and updates zero rows.
    const staleSecondsAgo = `-${Math.ceil(STALE_PROCESSING_MS / 1000)} seconds`;
    const reclaimed = await prisma.$executeRawUnsafe(
      `UPDATE "TelegramUpdate"
       SET status = 'processing', resultNote = NULL, updatedAt = strftime('%Y-%m-%dT%H:%M:%f', 'now') || 'Z'
       WHERE updateId = ? AND status = 'processing'
         AND updatedAt <= (strftime('%Y-%m-%dT%H:%M:%f', 'now', ?) || 'Z')`,
      updateId,
      staleSecondsAgo
    );
    if (Number(reclaimed) > 0) return { outcome: "claimed" };
    return claimTelegramUpdate(updateId, updateType);
  }

  return { outcome: "duplicate", status: existing.status, resultNote: existing.resultNote };
}

export async function completeTelegramUpdate(updateId: number, resultNote?: string): Promise<void> {
  await prisma.telegramUpdate.update({
    where: { updateId },
    data: { status: "completed", resultNote: resultNote?.slice(0, 300) },
  }).catch(() => {});
}

export async function failTelegramUpdate(updateId: number, resultNote?: string): Promise<void> {
  await prisma.telegramUpdate.update({
    where: { updateId },
    data: { status: "failed", resultNote: resultNote?.slice(0, 300) },
  }).catch(() => {});
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}
