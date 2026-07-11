import { prisma } from "./db";
import { encrypt, decrypt } from "./encrypt";
import {
  googleStatusFromError,
  recordGoogleAccountHealth,
  shortGoogleHealthError,
} from "./google-health";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Deduplicates concurrent refresh calls for the same account.
// If a refresh is already in flight, callers share the same Promise instead
// of each hitting Google independently — prevents the race where two parallel
// requests both see an expired token and both try to refresh it.
const inflightRefreshes = new Map<string, Promise<string>>();

/** Returns a valid (refreshed if needed) access token for the given GoogleAccount id. */
export async function getValidToken(
  googleAccountId: string,
  options: { recordHealth?: boolean } = {}
): Promise<string> {
  const shouldRecordHealth = options.recordHealth !== false;
  const account = await prisma.googleAccount.findUniqueOrThrow({
    where: { id: googleAccountId },
  });

  // Good for at least 60 more seconds — use as-is.
  if (account.expiresAt > new Date(Date.now() + 60_000)) {
    return decrypt(account.accessToken);
  }

  // If a refresh is already in flight for this account, wait for it.
  const inflight = inflightRefreshes.get(googleAccountId);
  if (inflight) {
    return inflight;
  }

  if (!account.refreshToken) {
    throw new Error(`No refresh token on account ${googleAccountId}. User must re-link.`);
  }

  const refreshPromise = (async (): Promise<string> => {
    try {
      // Re-read the account inside the lock — another request may have already
      // refreshed while we were waiting on the inflight check above.
      const fresh = await prisma.googleAccount.findUniqueOrThrow({
        where: { id: googleAccountId },
      });
      if (fresh.expiresAt > new Date(Date.now() + 60_000)) {
        return decrypt(fresh.accessToken);
      }

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decrypt(fresh.refreshToken!),
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
      });

      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };

      await prisma.googleAccount.update({
        where: { id: googleAccountId },
        data: {
          accessToken: encrypt(data.access_token),
          expiresAt: new Date(Date.now() + data.expires_in * 1000),
        },
      });
      if (shouldRecordHealth) {
        await recordGoogleAccountHealth(googleAccountId, "ok");
      }

      return data.access_token;
    } catch (err) {
      if (shouldRecordHealth) {
        await recordGoogleAccountHealth(
          googleAccountId,
          googleStatusFromError(err),
          shortGoogleHealthError(err)
        ).catch(() => undefined);
      }
      throw err;
    } finally {
      inflightRefreshes.delete(googleAccountId);
    }
  })();

  inflightRefreshes.set(googleAccountId, refreshPromise);
  return refreshPromise;
}
