// SSE streaming chat endpoint.
// Sends `ack` immediately (spinner starts), then `reply` when the LLM finishes.
// The existing POST /api/chat is unchanged — Telegram and cron still use it.
// Dashboard chat uses this endpoint to show a typing indicator without polling.

import { auth } from "@/lib/auth";
import { sendMessage } from "@/lib/chat";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(sseEvent("error", { message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const rl = rateLimit(`chat:${session.user.id}`, { limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = (await req.json().catch(() => null)) as { message?: string; agentName?: string } | null;
  if (!body?.message?.trim()) {
    return new Response(sseEvent("error", { message: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const userId = session.user.id;
  const trimmed = body.message.trim();
  const agentName = body.agentName?.trim() || null;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(sseEvent(event, data)));

      try {
        // Immediately acknowledge — dashboard shows typing indicator
        send("ack", { status: "processing" });

        const result = await sendMessage(userId, trimmed, "dashboard", agentName);

        send("reply", {
          userMessage: result.userMessage,
          reply: result.reply,
          pendingApprovals: result.route.pendingApprovals ?? [],
        });
        send("done", { status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error";
        console.error("[/api/chat/stream] error:", message);
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
