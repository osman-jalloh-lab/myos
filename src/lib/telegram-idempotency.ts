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

  const isStaleProcessing = existing.status === "processing" && Date.now() - existing.updatedAt.getTime() > STALE_PROCESSING_MS;
  if (existing.status === "failed" || isStaleProcessing) {
    const reclaimed = await prisma.telegramUpdate.updateMany({
      where: { updateId, status: existing.status },
      data: { status: "processing", resultNote: null },
    });
    if (reclaimed.count > 0) return { outcome: "claimed" };
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
