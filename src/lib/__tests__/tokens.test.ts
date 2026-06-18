import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Token refresh race condition tests ──────────────────────────────────────────
// Verifies the inflightRefreshes deduplication in tokens.ts.
// Mocks prisma and fetch — no real network or DB calls.

vi.mock("@/lib/db", () => ({
  prisma: {
    googleAccount: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/encrypt", () => ({
  encrypt: vi.fn((t: string) => `enc:${t}`),
  decrypt: vi.fn((t: string) => t.replace(/^enc:/, "")),
}));

import { prisma } from "@/lib/db";

const FRESH_EXPIRY = new Date(Date.now() + 5 * 60 * 1000); // 5 min from now
const STALE_EXPIRY = new Date(Date.now() - 60 * 1000);     // 1 min ago

const BASE_ACCOUNT = {
  id: "ga_1",
  userId: "user_1",
  googleSub: "sub_1",
  email: "osman@test.com",
  label: "Work",
  accessToken: "enc:old_token",
  refreshToken: "enc:refresh_token",
  expiresAt: STALE_EXPIRY,
  scopes: "email profile",
  isDefault: true,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the inflight cache between tests by reimporting — vitest caches modules
  // so we clear mocks and rely on the fact that inflightRefreshes is cleared in finally
});

describe("getValidToken", () => {
  it("returns token directly when not expired", async () => {
    vi.mocked(prisma.googleAccount.findUniqueOrThrow).mockResolvedValue({
      ...BASE_ACCOUNT,
      accessToken: "enc:fresh_token",
      expiresAt: FRESH_EXPIRY,
    });

    const { getValidToken } = await import("@/lib/tokens");
    const token = await getValidToken("ga_1");

    expect(token).toBe("fresh_token");
    expect(prisma.googleAccount.update).not.toHaveBeenCalled();
  });

  it("calls Google refresh API when token is expired", async () => {
    vi.mocked(prisma.googleAccount.findUniqueOrThrow).mockResolvedValue({
      ...BASE_ACCOUNT,
      expiresAt: STALE_EXPIRY,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new_access_token",
        expires_in: 3600,
      }),
    }) as unknown as typeof fetch;

    vi.mocked(prisma.googleAccount.update).mockResolvedValue({
      ...BASE_ACCOUNT,
      accessToken: "enc:new_access_token",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const { getValidToken } = await import("@/lib/tokens");
    const token = await getValidToken("ga_1");

    expect(fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(token).toBe("new_access_token");
  });

  it("deduplicates concurrent refresh calls for the same account", async () => {
    let resolveRefresh!: () => void;
    const refreshReady = new Promise<void>((r) => { resolveRefresh = r; });

    vi.mocked(prisma.googleAccount.findUniqueOrThrow).mockResolvedValue({
      ...BASE_ACCOUNT,
      expiresAt: STALE_EXPIRY,
    });

    let fetchCallCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      await refreshReady;
      return {
        ok: true,
        json: async () => ({ access_token: "refreshed_token", expires_in: 3600 }),
      };
    }) as unknown as typeof fetch;

    vi.mocked(prisma.googleAccount.update).mockResolvedValue({
      ...BASE_ACCOUNT,
      accessToken: "enc:refreshed_token",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const { getValidToken } = await import("@/lib/tokens");

    // Fire two concurrent refresh requests for the same account
    const [p1, p2] = [getValidToken("ga_1"), getValidToken("ga_1")];

    resolveRefresh();
    const [t1, t2] = await Promise.all([p1, p2]);

    // Both should return the same token
    expect(t1).toBe("refreshed_token");
    expect(t2).toBe("refreshed_token");
    // But fetch should only have been called once
    expect(fetchCallCount).toBe(1);
  });
});
