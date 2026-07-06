import { NextResponse } from "next/server";

const allowedHosts = [
  "localhost",
  "127.0.0.1",
];

function requirePreviewMode(): void {
  const host = (process.env.NEXT_PUBLIC_HOSTNAME || "").toLowerCase();
  const isLocal = allowedHosts.some((value) => host.includes(value));
  const isPreview = process.env.VERCEL_ENV === "preview";
  if (!isLocal && !isPreview) {
    throw new Error("NOT_ALLOWED");
  }
}

export async function enforcePreviewModeOr404(): Promise<void> {
  try {
    requirePreviewMode();
  } catch {
    throw new NextResponse("Not Found", { status: 404, headers: { "x-preview-mode": "0" } });
  }
}

export function isHostPreviewAllowed(hostname?: string): boolean {
  const host = (hostname || process.env.NEXT_PUBLIC_HOSTNAME || "").toLowerCase();
  const isLocal = allowedHosts.some((value) => host.includes(value));
  if (isLocal) return true;
  return process.env.VERCEL_ENV === "preview";
}
