import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createHmac, randomBytes } from "crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const VALID_LABELS = new Set(["Work", "UT", "Personal", "Other"]);

function signState(payload: string): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
  return (
    payload +
    "." +
    createHmac("sha256", secret).update(payload).digest("hex")
  );
}

/**
 * GET /api/accounts/link?label=Work|UT|Personal|Other
 * Redirects the signed-in user to Google OAuth to link an additional account.
 * The state token is HMAC-signed to prevent CSRF.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const label = searchParams.get("label") ?? "Other";
  if (!VALID_LABELS.has(label)) {
    return NextResponse.json({ error: "Invalid label" }, { status: 400 });
  }

  const nonce = randomBytes(8).toString("hex");
  const payload = `${session.user.id}:${label}:${nonce}`;
  const state = signState(payload);

  const redirectUri = `${requestUrl.origin}/api/accounts/callback`;

  const params = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ].join(" "),
    access_type: "offline",
    // Force account picker so user can select a different Google account.
    prompt: "consent select_account",
    state,
  });

  return NextResponse.redirect(`${GOOGLE_AUTH_URL}?${params}`);
}
