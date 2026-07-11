import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  googleAccountFindMany: vi.fn(),
  googleAccountFindUnique: vi.fn(),
  googleAccountFindUniqueOrThrow: vi.fn(),
  googleAccountUpdate: vi.fn(),
  agentRunCreate: vi.fn(),
  fetchInboxMessages: vi.fn(),
  fetchEmailBody: vi.fn(),
  getCorrespondentGraph: vi.fn(),
  classify: vi.fn(),
  sendTelegramMessage: vi.fn(),
  classifyEmailRoute: vi.fn(),
  routeActionEmailFollowUp: vi.fn(),
  routeToThemis: vi.fn(),
  routeToAthena: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
    googleAccount: {
      findMany: mocks.googleAccountFindMany,
      findUnique: mocks.googleAccountFindUnique,
      findUniqueOrThrow: mocks.googleAccountFindUniqueOrThrow,
      update: mocks.googleAccountUpdate,
    },
    agentRun: { create: mocks.agentRunCreate, findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/gmail", () => ({
  fetchInboxMessages: mocks.fetchInboxMessages,
  fetchEmailBody: mocks.fetchEmailBody,
  getCorrespondentGraph: mocks.getCorrespondentGraph,
  classify: mocks.classify,
}));

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: mocks.sendTelegramMessage,
}));

vi.mock("@/lib/agentHandoff", () => ({
  classifyEmailRoute: mocks.classifyEmailRoute,
  routeActionEmailFollowUp: mocks.routeActionEmailFollowUp,
  routeToThemis: mocks.routeToThemis,
  routeToAthena: mocks.routeToAthena,
}));

describe("Google account health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron_secret";
    process.env.TELEGRAM_OWNER_CHAT_ID = "owner_chat";
    mocks.googleAccountFindUnique.mockResolvedValue({ id: "acct_1", email: "work@example.com", label: "Work", lastSyncStatus: null });
    mocks.googleAccountUpdate.mockResolvedValue({});
    mocks.sendTelegramMessage.mockResolvedValue({});
  });

  it("classifies static account health before probing Google", async () => {
    const { classifyGoogleAccountHealth } = await import("../google-health");

    expect(
      classifyGoogleAccountHealth({
        id: "acct_1",
        email: "work@example.com",
        refreshToken: null,
        expiresAt: new Date(Date.now() + 60_000),
        scopes: "openid profile",
      })
    ).toBe("scope_missing");

    expect(
      classifyGoogleAccountHealth({
        id: "acct_2",
        email: "work@example.com",
        refreshToken: null,
        expiresAt: new Date(Date.now() - 60_000),
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
      })
    ).toBe("expired");
  });

  it("probeAccount returns scope_missing without mutating health state", async () => {
    mocks.googleAccountFindUniqueOrThrow.mockResolvedValue({
      id: "acct_1",
      email: "work@example.com",
      refreshToken: "enc:refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: "openid profile",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { probeAccount } = await import("../google-health");
    await expect(probeAccount("acct_1")).resolves.toEqual({
      accountId: "acct_1",
      email: "work@example.com",
      status: "scope_missing",
      error: "scope_missing",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.googleAccountUpdate).not.toHaveBeenCalled();
  });

  it("email watcher records expired Gmail accounts instead of silently skipping", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user_1" }]);
    mocks.googleAccountFindMany.mockResolvedValue([
      {
        id: "acct_expired",
        refreshToken: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);
    mocks.googleAccountFindUnique.mockResolvedValue({ id: "acct_expired", email: "work@example.com", label: "Work", lastSyncStatus: null });
    mocks.agentRunCreate.mockResolvedValue({});

    const { GET } = await import("@/app/api/cron/email-watcher/route");
    const res = await GET(
      new Request("https://example.com/api/cron/email-watcher", {
        headers: { authorization: "Bearer cron_secret" },
      })
    );

    expect(res.status).toBe(503);
    expect(mocks.googleAccountUpdate).toHaveBeenCalledWith({
      where: { id: "acct_expired" },
      data: expect.objectContaining({
        lastSyncStatus: "expired",
        lastError: expect.stringContaining("token expired"),
      }),
    });
    expect(mocks.agentRunCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentName: "email-watcher",
        inputSummary: "gmail_expired",
        status: "failed",
      }),
    });
    expect(mocks.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it("alerts only when account health transitions into an alerting failure", async () => {
    const { recordGoogleAccountHealth } = await import("../google-health");

    mocks.googleAccountFindUnique.mockResolvedValueOnce({
      id: "acct_1",
      email: "work@example.com",
      label: "Work",
      lastSyncStatus: "ok",
    });
    await recordGoogleAccountHealth("acct_1", "refresh_failed", "invalid_grant");

    mocks.googleAccountFindUnique.mockResolvedValueOnce({
      id: "acct_1",
      email: "work@example.com",
      label: "Work",
      lastSyncStatus: "refresh_failed",
    });
    await recordGoogleAccountHealth("acct_1", "refresh_failed", "invalid_grant");

    expect(mocks.sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mocks.agentRunCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentName: "account-health-watch",
        inputSummary: "account=acct_1 state=refresh_failed",
      }),
    });
  });
});
