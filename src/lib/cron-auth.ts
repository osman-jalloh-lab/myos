// Shared cron authentication guard.
// Usage: const deny = cronGuard(req); if (deny) return deny;
//
// Defends against two failure modes:
//  1. CRON_SECRET not set — "Bearer undefined" could match a crafted header
//  2. Secret present but header missing or wrong

import { NextRequest, NextResponse } from "next/server";

export function cronGuard(req: Request | NextRequest): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET is not set — rejecting all cron requests");
    return new Response("Service not configured", { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// NextResponse variant for routes that use NextResponse
export function cronGuardNext(req: Request | NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron-auth] CRON_SECRET is not set — rejecting all cron requests");
    return NextResponse.json({ error: "Service not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
