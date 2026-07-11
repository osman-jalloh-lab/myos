import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  googleAccountFindMany: vi.fn(),
  googleAccountFindUnique: vi.fn(),
  googleAccountUpdate: vi.fn(),
  agentRunCreate: vi.fn(),
  probeAccount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  prisma: {
    googleAccount: {
      findMany: mocks.googleAccountFindMany,
      findUnique: mocks.googleAccountFindUnique,
      update: mocks.googleAccountUpdate,
    },
    agentRun: { create: mocks.agentRunCreate },
  },
}));
vi.mock("@/lib/google-health", async () => {
  const actual = await vi.importActual<typeof import("../google-health")>("../google-health");
  return {
    ...actual,
    probeAccount: mocks.probeAccount,
    recordGoogleAccountHealth: actual.recordGoogleAccountHealth,
  };
});

const baseAccount = {
  id: "acct_1",
  email: "work@example.com",
  label: "Work",
  isDefault: true,
  scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  expiresAt: new Date(Date.now() - 60_000),
  createdAt: new Date("2026-07-11T12:00:00.000Z"),
  lastSyncedAt: null,
  lastSyncStatus: null,
  lastError: null,
  refreshToken: "enc:refresh",
};

describe("accounts API health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user_1", email: "osman@example.com", name: "Osman" } });
    mocks.googleAccountFindUnique.mockResolvedValue({ id: "acct_1", email: "work@example.com", label: "Work", lastSyncStatus: null });
    mocks.googleAccountUpdate.mockResolvedValue({});
    mocks.agentRunCreate.mockResolvedValue({});
  });

  it("computes expiring_soon for expired access token with refresh token and no recent probe", async () => {
    const { computeAccountHealth } = await import("@/app/api/accounts/route");

    expect(computeAccountHealth(baseAccount)).toBe("expiring_soon");
  });

  it("GET returns current session and linked account health without tokens", async () => {
    mocks.googleAccountFindMany.mockResolvedValue([baseAccount]);

    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET();
    const body = await res.json();

    expect(body.currentSession).toEqual({ userId: "user_1", email: "osman@example.com", name: "Osman" });
    expect(body.accounts[0]).toMatchObject({
      id: "acct_1",
      email: "work@example.com",
      health: "expiring_soon",
      gmailScope: true,
      calendarScope: true,
      reconnectRequired: false,
    });
    expect(JSON.stringify(body)).not.toContain("enc:refresh");
  });

  it("health-check probes accounts and records the live status", async () => {
    mocks.googleAccountFindMany
      .mockResolvedValueOnce([{ id: "acct_1" }])
      .mockResolvedValueOnce([{ ...baseAccount, lastSyncStatus: "ok", lastSyncedAt: new Date("2026-07-11T12:30:00.000Z") }]);
    mocks.probeAccount.mockResolvedValue({ accountId: "acct_1", email: "work@example.com", status: "ok", error: null });

    const { POST } = await import("@/app/api/accounts/health-check/route");
    const res = await POST();
    const body = await res.json();

    expect(mocks.probeAccount).toHaveBeenCalledWith("acct_1");
    expect(mocks.googleAccountUpdate).toHaveBeenCalledWith({
      where: { id: "acct_1" },
      data: expect.objectContaining({ lastSyncStatus: "ok", lastError: null }),
    });
    expect(body.results).toEqual([{ accountId: "acct_1", email: "work@example.com", status: "ok", error: null }]);
    expect(body.accounts[0].health).toBe("connected");
  });
});
