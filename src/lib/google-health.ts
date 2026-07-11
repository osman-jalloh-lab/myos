import { prisma } from "./db";
import { sendTelegramMessage } from "./telegram";

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export type GoogleSyncStatus = "ok" | "expired" | "refresh_failed" | "scope_missing";

export interface GoogleAccountHealthResult {
  accountId: string;
  status: GoogleSyncStatus;
  email?: string;
  error?: string | null;
}

type HealthAccount = {
  id: string;
  email: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string;
};

function hasGmailScope(scopes: string): boolean {
  return /gmail/i.test(scopes);
}

export function classifyGoogleAccountHealth(account: HealthAccount, now = new Date()): GoogleSyncStatus | null {
  if (!hasGmailScope(account.scopes)) return "scope_missing";
  if (!account.refreshToken && account.expiresAt <= now) return "expired";
  return null;
}

export function googleStatusFromError(err: unknown): GoogleSyncStatus {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("scope") || lower.includes("insufficient permissions") || lower.includes("403")) {
    return "scope_missing";
  }
  if (lower.includes("no refresh token") || lower.includes("invalid_grant") || lower.includes("401")) {
    return "expired";
  }
  return "refresh_failed";
}

export function shortGoogleHealthError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

async function alertGoogleAccountHealthTransition(
  account: { id: string; email: string; label: string | null; lastSyncStatus: string | null } | null,
  status: GoogleSyncStatus,
  error?: string | null
): Promise<void> {
  if (!account || (status !== "expired" && status !== "refresh_failed")) return;
  if (account.lastSyncStatus === status) return;

  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  let alerted = false;
  if (chatId) {
    await sendTelegramMessage(
      chatId,
      [
        "Google account needs attention.",
        `${account.label ?? "Google"} (${account.email}) changed to ${status}.`,
        error ? `Reason: ${error.slice(0, 300)}` : "Reconnect or test the connection from Command Center.",
      ].join("\n")
    ).then(() => { alerted = true; }).catch(() => undefined);
  }

  await prisma.agentRun.create({
    data: {
      agentName: "account-health-watch",
      inputSummary: `account=${account.id} state=${status}`,
      outputSummary: alerted
        ? `Google account ${account.email} changed to ${status}; Telegram alert sent.`
        : `Google account ${account.email} changed to ${status}; Telegram alert failed or not configured.`,
      modelProvider: "internal",
      status: alerted ? "completed" : "failed",
    },
  }).catch(() => undefined);
}

export async function recordGoogleAccountHealth(
  accountId: string,
  status: GoogleSyncStatus,
  error?: string | null,
  syncedAt = new Date()
): Promise<void> {
  const previous = await prisma.googleAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, label: true, lastSyncStatus: true },
  }).catch(() => null);

  await prisma.googleAccount.update({
    where: { id: accountId },
    data: {
      lastSyncStatus: status,
      lastError: status === "ok" ? null : error ?? status,
      ...(status === "ok" ? { lastSyncedAt: syncedAt } : {}),
    },
  });
  await alertGoogleAccountHealthTransition(previous, status, error);
}

export async function recordGoogleAccountSkip(
  accountId: string,
  status: Exclude<GoogleSyncStatus, "ok">,
  reason?: string
): Promise<void> {
  await recordGoogleAccountHealth(accountId, status, reason ?? status);
}

export async function probeAccount(accountId: string): Promise<GoogleAccountHealthResult> {
  const account = await prisma.googleAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      id: true,
      email: true,
      refreshToken: true,
      expiresAt: true,
      scopes: true,
    },
  });

  const staticStatus = classifyGoogleAccountHealth(account);
  if (staticStatus) {
    return { accountId, email: account.email, status: staticStatus, error: staticStatus };
  }

  try {
    const { getValidToken } = await import("./tokens");
    const token = await getValidToken(accountId, { recordHealth: false });
    const res = await fetch(GMAIL_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Gmail profile probe failed (${res.status})`);
    }
    return { accountId, email: account.email, status: "ok", error: null };
  } catch (err) {
    return {
      accountId,
      email: account.email,
      status: googleStatusFromError(err),
      error: shortGoogleHealthError(err),
    };
  }
}
