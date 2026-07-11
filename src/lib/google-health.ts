import { prisma } from "./db";

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

export async function recordGoogleAccountHealth(
  accountId: string,
  status: GoogleSyncStatus,
  error?: string | null,
  syncedAt = new Date()
): Promise<void> {
  await prisma.googleAccount.update({
    where: { id: accountId },
    data: {
      lastSyncStatus: status,
      lastError: status === "ok" ? null : error ?? status,
      ...(status === "ok" ? { lastSyncedAt: syncedAt } : {}),
    },
  });
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
