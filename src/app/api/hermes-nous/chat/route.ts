import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listHermesNousMessages, queueHermesNousMessage } from "@/lib/hermes-nous-chat";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const messages = await listHermesNousMessages(session.user.id, 50);
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit(`hermes-nous-chat:${session.user.id}`, { limit: 12, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = (await req.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const queued = await queueHermesNousMessage(session.user.id, message);
  return NextResponse.json({
    userMessage: queued.userMessage,
    taskId: queued.taskId,
    hermesSessionId: queued.hermesSessionId,
    status: "queued",
  });
}
