import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { transcript?: string } | null;
  const transcript = (body?.transcript ?? "").trim();
  if (!transcript) {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  const preview = {
    action: transcript,
    risk: /\b(build|deploy|send|email|calendar|event|meeting|delete|remove|update|change|write|save|publish|post)\b/i.test(transcript)
      ? "write"
      : "read",
    summary: transcript,
  };

  return NextResponse.json({
    ok: true,
    transcript,
    preview,
    requiresApproval: preview.risk !== "read",
  });
}
