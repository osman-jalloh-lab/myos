import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { chatHistory, sendMessage } from "@/lib/chat";
import { shouldUseExecutionLayer } from "@/lib/hermes-execution/detect-execution-request";

/**
 * GET  /api/chat?agent=<name>  — recent chat history for a thread
 * POST /api/chat               — send a message, get a routed reply
 *
 * Omitting `agent` (or passing none) targets the general Hermes thread,
 * routed through Hermes.routeMessage(). Passing an agent name targets that
 * agent's private thread, routed through Hermes.routeToAgent() — the agent
 * answers in its own voice from its own existing read tools. Both paths and
 * both the dashboard chat panel and the Telegram bridge ultimately funnel
 * through sendMessage() -> the same approval-queue and read-tool surfaces
 * every other client uses. Chat is a new *client*, never a new write path
 * (CLAUDE.md rule 3).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const agent = new URL(req.url).searchParams.get("agent");
  const messages = await chatHistory(session.user.id, 50, agent || null);
  return NextResponse.json({ messages });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { message?: string; agentName?: string } | null;
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const trimmed = body.message.trim();

  // ── execution layer (feature-flagged, additive) ─────────────────────────────
  // When HERMES_EXECUTION_ENABLED=true and the message matches an action intent,
  // proxy through /api/hermes/execute and merge the execution result into the
  // standard chat reply shape so the existing UI receives the same structure.
  if (!body.agentName && shouldUseExecutionLayer(trimmed)) {
    try {
      const execRes = await fetch(
        new URL("/api/hermes/execute", process.env.NEXTAUTH_URL ?? "http://localhost:3000").toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forward the session cookie so the execute route can auth
            Cookie: (req as Request & { headers: { get: (k: string) => string | null } }).headers.get("cookie") ?? "",
          },
          body: JSON.stringify({ message: trimmed, source: "chat" }),
        }
      );
      if (execRes.ok) {
        const execData = (await execRes.json()) as { answer?: string; status?: string; artifacts?: unknown[]; toolCalls?: unknown[] };
        // Also persist the message pair to chat history via normal path (silent, no LLM)
        const result = await sendMessage(session.user.id, trimmed, "dashboard", null);
        return NextResponse.json({
          userMessage: result.userMessage,
          reply: {
            ...result.reply,
            content: execData.answer ?? result.reply.content,
            executionStatus: execData.status,
            artifacts: execData.artifacts ?? [],
            toolCalls: execData.toolCalls ?? [],
          },
        });
      }
    } catch {
      // Execution layer failure is non-fatal — fall through to normal chat path
      console.error("[/api/chat] execution layer proxy failed, falling back to normal chat");
    }
  }

  const result = await sendMessage(session.user.id, trimmed, "dashboard", body.agentName?.trim() || null);
  return NextResponse.json({ userMessage: result.userMessage, reply: result.reply });
}
