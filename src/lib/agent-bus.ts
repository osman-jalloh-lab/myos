import { createApproval } from "@/lib/approvals";
import { prisma } from "@/lib/db";

export type AgentEnvelopeStatus = "pending" | "consumed" | "expired";

export type AgentEnvelopeView = {
  id: string;
  userId: string;
  fromAgent: string;
  toAgent: string | null;
  envelopeType: string;
  payload: unknown;
  status: AgentEnvelopeStatus;
  correlationId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

type AgentEnvelopeRow = {
  id: string;
  userId: string;
  fromAgent: string;
  toAgent: string | null;
  envelopeType: string;
  payload: string;
  status: string;
  correlationId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type PublishAgentEnvelopeInput = {
  userId: string;
  fromAgent: string;
  toAgent?: string | null;
  envelopeType: string;
  payload: unknown;
  ttlMs?: number;
  correlationId?: string | null;
};

function toView(row: AgentEnvelopeRow): AgentEnvelopeView {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    userId: row.userId,
    fromAgent: row.fromAgent,
    toAgent: row.toAgent,
    envelopeType: row.envelopeType,
    payload,
    status: row.status as AgentEnvelopeStatus,
    correlationId: row.correlationId,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function publishAgentEnvelope(input: PublishAgentEnvelopeInput): Promise<AgentEnvelopeView> {
  const ttlMs = Math.min(Math.max(input.ttlMs ?? 24 * 60 * 60 * 1000, 60_000), 7 * 24 * 60 * 60 * 1000);
  const row = await prisma.agentEnvelope.create({
    data: {
      userId: input.userId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent ?? null,
      envelopeType: input.envelopeType,
      payload: JSON.stringify(input.payload),
      correlationId: input.correlationId ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return toView(row as AgentEnvelopeRow);
}

export async function expireAgentEnvelopes(userId: string): Promise<number> {
  const result = await prisma.agentEnvelope.updateMany({
    where: { userId, status: "pending", expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
  return result.count;
}

export async function consumeAgentEnvelopes(params: { userId: string; toAgent?: string | null; limit?: number }): Promise<AgentEnvelopeView[]> {
  await expireAgentEnvelopes(params.userId);
  const toAgent = params.toAgent ?? null;
  const rows = await prisma.agentEnvelope.findMany({
    where: {
      userId: params.userId,
      status: "pending",
      expiresAt: { gt: new Date() },
      OR: [{ toAgent }, { toAgent: null }],
    },
    orderBy: { createdAt: "asc" },
    take: params.limit ?? 5,
  });
  if (rows.length > 0) {
    await prisma.agentEnvelope.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { status: "consumed", consumedAt: new Date() },
    });
  }
  return rows.map((row) => toView(row as AgentEnvelopeRow));
}

export function formatAgentEnvelopeContext(envelopes: AgentEnvelopeView[]): string | null {
  if (!envelopes.length) return null;
  const lines = ["AGENT BUS ENVELOPES"];
  for (const envelope of envelopes) {
    lines.push(`- ${envelope.fromAgent} -> ${envelope.toAgent ?? "any"} [${envelope.envelopeType}]: ${JSON.stringify(envelope.payload).slice(0, 500)}`);
  }
  return lines.join("\n");
}

export async function requestAgentHandoff(input: PublishAgentEnvelopeInput) {
  if (input.envelopeType === "task_handoff") {
    return {
      status: "approval_required" as const,
      approval: await createApproval(input.userId, "task_handoff", input),
    };
  }
  return {
    status: "published" as const,
    envelope: await publishAgentEnvelope(input),
  };
}

export async function executeApprovedAgentHandoff(payload: unknown, userId: string): Promise<AgentEnvelopeView> {
  const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Partial<PublishAgentEnvelopeInput> : {};
  return publishAgentEnvelope({
    userId,
    fromAgent: String(raw.fromAgent ?? "hermes"),
    toAgent: raw.toAgent === undefined ? null : String(raw.toAgent),
    envelopeType: String(raw.envelopeType ?? "task_handoff"),
    payload: raw.payload ?? {},
    ttlMs: typeof raw.ttlMs === "number" ? raw.ttlMs : undefined,
    correlationId: raw.correlationId ?? null,
  });
}
