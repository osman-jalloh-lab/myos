import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const envelopes = await prisma.agentEnvelope.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  const counts = envelopes.reduce<Record<string, number>>((acc, envelope) => {
    acc[envelope.status] = (acc[envelope.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    envelopes: envelopes.map((envelope) => ({
      id: envelope.id,
      fromAgent: envelope.fromAgent,
      toAgent: envelope.toAgent,
      envelopeType: envelope.envelopeType,
      payload: parsePayload(envelope.payload),
      status: envelope.status,
      correlationId: envelope.correlationId,
      expiresAt: envelope.expiresAt.toISOString(),
      consumedAt: envelope.consumedAt?.toISOString() ?? null,
      createdAt: envelope.createdAt.toISOString(),
    })),
    counts,
    lastUpdated: new Date().toISOString(),
  });
}
