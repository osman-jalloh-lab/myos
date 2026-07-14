import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { chatHistory, channelHistory, persistExecutedMessage, sendMessage } from "@/lib/chat";
import { handleBuildIntake } from "@/lib/build-intake";
import { shouldUseExecutionLayer } from "@/lib/hermes-execution/detect-execution-request";
import { skillResolutionToExecutionPlan } from "@/lib/hermes-execution/execution-bridge";
import { runHermesExecution, runHermesExecutionPlan } from "@/lib/hermes-execution/run";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { normalizeAgentKey } from "@/lib/agent-roster";
import { recordSkillUsageTelemetry, resolveRelevantSkills } from "@/lib/skills/routing";
import { handleProjectControlChat } from "@/lib/project-control/chat-workflow";

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
  try {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const channel = params.get("channel");
  if (channel === "telegram") {
    // Telegram mirror — everything flowing through the bot, read-only.
    const messages = await channelHistory(session.user.id, "telegram", 30);
    return NextResponse.json({ messages });
  }
  const rawAgent = params.get("agent");
  const agent = rawAgent ? normalizeAgentKey(rawAgent) : null;
  const messages = await chatHistory(session.user.id, 50, agent || null);
  return NextResponse.json({ messages });
  } catch (error) {
    console.error("[/api/chat] GET failed", error);
    return NextResponse.json({ error: "Chat history is temporarily unavailable." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 20 messages per minute per user — generous for normal use, blocks runaway loops
  const rl = rateLimit(`chat:${session.user.id}`, { limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = (await req.json().catch(() => null)) as { message?: string; agentName?: string } | null;
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const trimmed = body.message.trim();
  const contextChatId = `dashboard:shared:${session.user.id}`;
  const targetAgent = body.agentName?.trim() ? normalizeAgentKey(body.agentName) : null;
  const projectWorkflow = await handleProjectControlChat({
    userId: session.user.id,
    message: trimmed,
    targetAgent,
  }).catch((error) => {
    console.error("[/api/chat] project-control routing failed", error);
    return null;
  });
  if (!targetAgent && projectWorkflow?.handled && projectWorkflow.answer) {
    const result = await persistExecutedMessage(session.user.id, trimmed, projectWorkflow.answer, "dashboard");
    return NextResponse.json({
      classification: projectWorkflow.classification,
      projectId: projectWorkflow.projectId,
      planId: projectWorkflow.planId,
      userMessage: result.userMessage,
      reply: {
        ...result.reply,
        content: projectWorkflow.answer,
        executionStatus: "project_control",
        quickActions: projectWorkflow.quickActions ?? [],
        artifacts: [],
        toolCalls: [],
      },
    });
  }
  const intake = !targetAgent
    ? await handleBuildIntake(contextChatId, session.user.id, trimmed).catch(() => ({ action: "none" as const }))
    : { action: "none" as const };
  if (intake.action === "ask") {
    const result = await persistExecutedMessage(session.user.id, trimmed, intake.answer, "dashboard");
    return NextResponse.json({
      userMessage: result.userMessage,
      reply: {
        ...result.reply,
        content: intake.answer,
        executionStatus: "waiting_for_requirements",
        quickActions: intake.options,
        artifacts: [],
        toolCalls: [],
      },
    });
  }
  const executionMessage = intake.action === "ready" ? intake.message : trimmed;

  const skillResolution = !targetAgent
    ? await resolveRelevantSkills({ userId: session.user.id, message: executionMessage, maxSkills: 3 }).catch(() => null)
    : null;
  const skillPlan = skillResolution ? skillResolutionToExecutionPlan(skillResolution, executionMessage) : null;
  if (!targetAgent && skillResolution && skillPlan) {
    try {
      const execData = await runHermesExecutionPlan(session.user.id, executionMessage, "chat", skillPlan);
      await recordSkillUsageTelemetry({ userId: session.user.id, resolution: skillResolution, modelCallAvoided: true, executed: true }).catch(() => undefined);
      const answer = execData.answer ?? "Execution completed without a result summary.";
      const result = await persistExecutedMessage(session.user.id, trimmed, answer, "dashboard");
      return NextResponse.json({
        userMessage: result.userMessage,
        reply: {
          ...result.reply,
          content: answer,
          executionStatus: execData.status,
          artifacts: execData.artifacts ?? [],
          toolCalls: [],
        },
      });
    } catch {
      console.error("[/api/chat] skill execution bridge failed, falling back to normal routing");
    }
  }

  // ── execution layer (feature-flagged, additive) ─────────────────────────────
  // When HERMES_EXECUTION_ENABLED=true and the message matches an action intent,
  // call the shared execution runner and merge the execution result into the
  // standard chat reply shape so the existing UI receives the same structure.
  if (!targetAgent && shouldUseExecutionLayer(executionMessage)) {
    try {
      const execData = await runHermesExecution(session.user.id, executionMessage, "chat");
      const answer = execData.answer ?? "Execution completed without a result summary.";
      const result = await persistExecutedMessage(session.user.id, trimmed, answer, "dashboard");
      return NextResponse.json({
        userMessage: result.userMessage,
        reply: {
          ...result.reply,
          content: answer,
          executionStatus: execData.status,
          artifacts: execData.artifacts ?? [],
          toolCalls: [],
        },
      });
    } catch {
      // Execution layer failure is non-fatal — fall through to normal chat path
      console.error("[/api/chat] execution layer proxy failed, falling back to normal chat");
    }
  }

  try {
    const result = await sendMessage(session.user.id, trimmed, "dashboard", targetAgent);
    return NextResponse.json({ userMessage: result.userMessage, reply: result.reply });
  } catch (error) {
    console.error("[/api/chat] POST failed", error);
    return NextResponse.json({ error: "Hermes could not process that message. Check the server log for details." }, { status: 500 });
  }
}
