import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** GET /api/accounts — list all linked Google accounts (no tokens exposed). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.googleAccount.findMany({
    where: { userId: session.user.id },
    select: {
      id: true,
      email: true,
      label: true,
      isDefault: true,
      scopes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ accounts });
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
