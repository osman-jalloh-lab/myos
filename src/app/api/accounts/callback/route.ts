import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encrypt";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function verifyState(state: string): { userId: string; label: string } | null {
  const lastDot = state.lastIndexOf(".");
  if (lastDot === -1) return null;
  const payload = state.slice(0, lastDot);
  const sig = state.slice(lastDot + 1);
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time compare via Buffer to prevent timing attacks.
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return null;
  if (!sigBuf.equals(expBuf)) return null;
  const [userId, label] = payload.split(":");
  if (!userId || !label) return null;
  return { userId, label };
}

/**
 * GET /api/accounts/callback
 * Receives the OAuth code from Google, exchanges it for tokens, stores the
 * linked account in GoogleAccount, then redirects back to the dashboard.
 */
export async function GET(request: Request) {
  const baseUrl = process.env.NEXTAUTH_URL!;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${baseUrl}/?error=google_${error}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/?error=missing_params`);
  }

  const parsed = verifyState(state);
  if (!parsed) {
    return NextResponse.redirect(`${baseUrl}/?error=invalid_state`);
  }

  const redirectUri = `${baseUrl}/api/accounts/callback`;

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${baseUrl}/?error=token_exchange_failed`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    return NextResponse.redirect(`${baseUrl}/?error=userinfo_failed`);
  }

  const userInfo = (await userRes.json()) as { sub: string; email: string };
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await prisma.googleAccount.upsert({
    where: {
      userId_googleSub: { userId: parsed.userId, googleSub: userInfo.sub },
    },
    update: {
      label: parsed.label,
      accessToken: encrypt(tokens.access_token),
      ...(tokens.refresh_token && {
        refreshToken: encrypt(tokens.refresh_token),
      }),
      expiresAt,
      scopes: tokens.scope,
    },
    create: {
      userId: parsed.userId,
      googleSub: userInfo.sub,
      email: userInfo.email,
      label: parsed.label,
      accessToken: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token
        ? encrypt(tokens.refresh_token)
        : null,
      expiresAt,
      scopes: tokens.scope,
      isDefault: false,
    },
  });

  return NextResponse.redirect(`${baseUrl}/?linked=true`);
}
