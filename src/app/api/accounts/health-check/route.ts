import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { probeAccount, recordGoogleAccountHealth } from "@/lib/google-health";
import { getAccountsPayloadForUser } from "../route";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.googleAccount.findMany({
    where: { userId: session.user.id },
    select: { id: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  const results = await Promise.all(
    accounts.map(async (account) => {
      const result = await probeAccount(account.id);
      await recordGoogleAccountHealth(account.id, result.status, result.error);
      return result;
    })
  );

  return NextResponse.json({
    ...(await getAccountsPayloadForUser(session.user.id, session.user)),
    results,
  });
}
