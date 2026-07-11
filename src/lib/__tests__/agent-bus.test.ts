import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApproval: vi.fn(),
  agentEnvelopeCreate: vi.fn(),
  agentEnvelopeFindMany: vi.fn(),
  agentEnvelopeUpdateMany: vi.fn(),
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: mocks.createApproval,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    agentEnvelope: {
      create: mocks.agentEnvelopeCreate,
      findMany: mocks.agentEnvelopeFindMany,
      updateMany: mocks.agentEnvelopeUpdateMany,
    },
  },
}));

import {
  consumeAgentEnvelopes,
  formatAgentEnvelopeContext,
  publishAgentEnvelope,
  requestAgentHandoff,
} from "@/lib/agent-bus";

const createdAt = new Date("2026-07-11T18:00:00.000Z");
const expiresAt = new Date("2026-07-12T18:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentEnvelopeCreate.mockImplementation(async ({ data }) => ({
    id: "env_1",
    status: "pending",
    consumedAt: null,
    createdAt,
    ...data,
  }));
  mocks.agentEnvelopeFindMany.mockResolvedValue([
    {
      id: "env_1",
      userId: "user_1",
      fromAgent: "athena",
      toAgent: "hermes",
      envelopeType: "context_note",
      payload: JSON.stringify({ note: "Use the GRC shortlist." }),
      status: "pending",
      correlationId: null,
      expiresAt,
      consumedAt: null,
      createdAt,
    },
  ]);
  mocks.agentEnvelopeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.createApproval.mockResolvedValue({
    id: "approval_1",
    actionType: "task_handoff",
    payload: {},
    status: "pending",
    createdAt: createdAt.toISOString(),
    resolvedAt: null,
  });
});

describe("agent bus", () => {
  it("publishes envelopes as pending rows", async () => {
    const envelope = await publishAgentEnvelope({
      userId: "user_1",
      fromAgent: "athena",
      toAgent: "hermes",
      envelopeType: "context_note",
      payload: { note: "Use the GRC shortlist." },
      correlationId: "corr_1",
    });

    expect(envelope).toMatchObject({
      id: "env_1",
      status: "pending",
      fromAgent: "athena",
      toAgent: "hermes",
      payload: { note: "Use the GRC shortlist." },
    });
    expect(mocks.agentEnvelopeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: "user_1",
        payload: JSON.stringify({ note: "Use the GRC shortlist." }),
        correlationId: "corr_1",
      }),
    }));
  });

  it("expires stale envelopes before consuming pending context", async () => {
    const envelopes = await consumeAgentEnvelopes({ userId: "user_1", toAgent: "hermes" });

    expect(mocks.agentEnvelopeUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ status: "pending", expiresAt: expect.objectContaining({ lt: expect.any(Date) }) }),
        data: { status: "expired" },
      })
    );
    expect(mocks.agentEnvelopeUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: { in: ["env_1"] } },
        data: expect.objectContaining({ status: "consumed", consumedAt: expect.any(Date) }),
      })
    );
    expect(formatAgentEnvelopeContext(envelopes)).toContain("AGENT BUS ENVELOPES");
  });

  it("queues task handoffs for approval instead of publishing immediately", async () => {
    const result = await requestAgentHandoff({
      userId: "user_1",
      fromAgent: "athena",
      toAgent: "hermes",
      envelopeType: "task_handoff",
      payload: { title: "Follow up with recruiter" },
    });

    expect(result.status).toBe("approval_required");
    expect(mocks.createApproval).toHaveBeenCalledWith(
      "user_1",
      "task_handoff",
      expect.objectContaining({
        fromAgent: "athena",
        envelopeType: "task_handoff",
      })
    );
    expect(mocks.agentEnvelopeCreate).not.toHaveBeenCalled();
  });
});
