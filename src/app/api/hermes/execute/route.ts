// POST /api/hermes/execute
// Additive execution endpoint — does NOT touch existing /api/chat route.
// Only active when HERMES_EXECUTION_ENABLED=true in env.
// Auth: same session gate as /api/chat.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { userSafeFailureMessage } from "@/lib/hermes-execution/response-formatter";
import { runHermesExecution } from "@/lib/hermes-execution/run";
import type { ExecutionRequest } from "@/lib/hermes-execution/types";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: Request) {
  // ── auth: session (browser) OR API key (MCP gateway) ─────────────────────
  const incomingKey = req.headers.get("X-Parawi-Key");
  const configuredKey = process.env.PARAWI_MCP_API_KEY;
  const isMcpGateway = configuredKey && incomingKey && incomingKey === configuredKey;

  let userId: string;
  if (isMcpGateway) {
    userId = "mcp-gateway";
  } else {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = session.user.id;
  }

  // 10 executions per minute — tighter than chat since each call spins up tools
  const rl = rateLimit(`execute:${userId}`, { limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  // ── parse body ─────────────────────────────────────────────────────────────
  const body = (await req.json().catch(() => null)) as {
    message?: string;
    source?: string;
    sessionId?: string;
    context?: ExecutionRequest["context"];
  } | null;

  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const execReq: ExecutionRequest = {
    userId,
    message: body.message.trim(),
    source: (body.source as ExecutionRequest["source"]) ?? "api",
    sessionId: body.sessionId,
    context: body.context,
  };

  // ── run ────────────────────────────────────────────────────────────────────
  try {
    const result = await runHermesExecution(execReq.userId, execReq.message, execReq.source, {
      sessionId: execReq.sessionId,
      context: execReq.context,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/hermes/execute] unhandled error", err);
    return NextResponse.json(
      {
        status: "failed",
        answer: userSafeFailureMessage(err instanceof Error ? err.message : String(err)),
        toolCalls: [],
        artifacts: [],
        error: userSafeFailureMessage(err instanceof Error ? err.message : String(err)),
      },
      { status: 500 }
    );
  }
}
