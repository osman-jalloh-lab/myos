// POST /api/hermes/execute
// Additive execution endpoint — does NOT touch existing /api/chat route.
// Only active when HERMES_EXECUTION_ENABLED=true in env.
// Auth: same session gate as /api/chat.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { plan } from "@/lib/hermes-execution/planner";
import { execute } from "@/lib/hermes-execution/executor";
import { ensureRegistryInitialized } from "@/lib/hermes-execution/tool-registry";
import { loadMcpToolsIntoRegistry } from "@/lib/hermes-execution/mcp-adapter";
import type { ExecutionRequest } from "@/lib/hermes-execution/types";

// Initialize tool registry on first request (lazy, not at module load)
let registryReady = false;
async function initRegistry() {
  if (registryReady) return;
  await ensureRegistryInitialized();
  await loadMcpToolsIntoRegistry();
  registryReady = true;
}

export async function POST(req: Request) {
  // ── feature flag ───────────────────────────────────────────────────────────
  if (process.env.HERMES_EXECUTION_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Execution layer is not enabled. Set HERMES_EXECUTION_ENABLED=true." },
      { status: 503 }
    );
  }

  // ── auth ───────────────────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    userId: session.user.id,
    message: body.message.trim(),
    source: (body.source as ExecutionRequest["source"]) ?? "chat",
    sessionId: body.sessionId,
    context: body.context,
  };

  // ── run ────────────────────────────────────────────────────────────────────
  try {
    await initRegistry();
    const execPlan = plan(execReq);
    const result = await execute(execPlan, execReq);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/hermes/execute] unhandled error", err);
    return NextResponse.json(
      {
        status: "failed",
        answer: "An unexpected error occurred in the execution layer. Check server logs.",
        toolCalls: [],
        artifacts: [],
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
