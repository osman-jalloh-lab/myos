import { prisma } from "./db";
import { encrypt, decrypt } from "./encrypt";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Returns a valid (refreshed if needed) access token for the given GoogleAccount id. */
export async function getValidToken(googleAccountId: string): Promise<string> {
  const account = await prisma.googleAccount.findUniqueOrThrow({
    where: { id: googleAccountId },
  });

  // Good for at least 60 more seconds — use as-is.
  if (account.expiresAt > new Date(Date.now() + 60_000)) {
    return decrypt(account.accessToken);
  }

  if (!account.refreshToken) {
    throw new Error(`No refresh token on account ${googleAccountId}. User must re-link.`);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: decrypt(account.refreshToken),
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

  return data.access_token;
}
