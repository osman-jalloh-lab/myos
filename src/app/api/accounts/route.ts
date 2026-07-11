import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

type AccountRow = {
  id: string;
  email: string;
  label: string;
  isDefault: boolean;
  scopes: string;
  expiresAt: Date;
  createdAt: Date;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  refreshToken: string | null;
};

export type AccountHealth = "connected" | "expiring_soon" | "disconnected" | "unknown";

function hasScope(scopes: string, needle: string): boolean {
  return scopes.toLowerCase().includes(needle);
}

export function computeAccountHealth(account: AccountRow, now = new Date()): AccountHealth {
  if (account.lastSyncStatus === "ok") return "connected";
  if (account.lastSyncStatus === "expired" || account.lastSyncStatus === "refresh_failed" || account.lastSyncStatus === "scope_missing") {
    return "disconnected";
  }
  if (account.expiresAt > now) return "connected";
  if (account.refreshToken) {
    const lastTestedAt = account.lastSyncedAt?.getTime() ?? 0;
    return now.getTime() - lastTestedAt > 24 * 60 * 60 * 1000 ? "expiring_soon" : "unknown";
  }
  return "disconnected";
}

function accountPayload(account: AccountRow) {
  const gmailScope = hasScope(account.scopes, "gmail");
  const calendarScope = hasScope(account.scopes, "calendar");
  const health = computeAccountHealth(account);
  return {
    id: account.id,
    email: account.email,
    label: account.label,
    isDefault: account.isDefault,
    scopes: account.scopes,
    gmailScope,
    calendarScope,
    createdAt: account.createdAt.toISOString(),
    tokenExpiresAt: account.expiresAt.toISOString(),
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    lastSyncStatus: account.lastSyncStatus,
    lastError: account.lastError,
    health,
    reconnectRequired: health === "disconnected" || !gmailScope || !calendarScope,
  };
}

export async function getAccountsPayloadForUser(userId: string, sessionUser?: { email?: string | null; name?: string | null }) {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: {
      id: true,
      email: true,
      label: true,
      isDefault: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
      lastSyncedAt: true,
      lastSyncStatus: true,
      lastError: true,
      refreshToken: true,
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  return {
    currentSession: {
      userId,
      email: sessionUser?.email ?? null,
      name: sessionUser?.name ?? null,
    },
    accounts: accounts.map(accountPayload),
  };
}

/** GET /api/accounts — list all linked Google accounts (no tokens exposed). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await getAccountsPayloadForUser(session.user.id, session.user));
}

/** DELETE /api/accounts?id=<accountId> — disconnect a linked account. */
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const account = await prisma.googleAccount.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const count = await prisma.googleAccount.count({
    where: { userId: session.user.id },
  });
  if (count <= 1) {
    return NextResponse.json(
      { error: "Cannot remove the only linked account" },
      { status: 400 }
    );
  }

  await prisma.googleAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
