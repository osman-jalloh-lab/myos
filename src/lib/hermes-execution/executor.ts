// Hermes Execution Layer — executor
// Runs an ExecutionPlan step by step.
// Uses the existing AgentRun table for logging (no new DB table needed).

import { prisma } from "@/lib/db";
import { getTool } from "./tool-registry";
import type {
  ExecutionPlan,
  ExecutionRequest,
  ExecutionResponse,
  ExecutionToolCall,
  ExecutionArtifact,
  ToolContext,
} from "./types";

// ── blocked actions (always blocked, no approval possible) ───────────────────

const ALWAYS_BLOCKED_TOOLS = new Set([
  "internal.email.send",
  "internal.email.deleteThread",
  "internal.file.delete",
  "internal.job.applyNow",
  "internal.payment.execute",
]);

// ── executor ──────────────────────────────────────────────────────────────────

export async function execute(
  plan: ExecutionPlan,
  req: ExecutionRequest
): Promise<ExecutionResponse> {
  const toolCalls: ExecutionToolCall[] = [];
  const artifacts: ExecutionArtifact[] = [];
  const previousResults: Record<string, unknown> = {};

  const ctx: ToolContext = {
    userId: req.userId,
    sessionId: req.sessionId,
    source: req.source,
    previousResults,
    env: process.env,
  };

  console.log(`[hermes-execution] intent=${plan.intent} steps=${plan.steps.length} user=${req.userId}`);

  for (const step of plan.steps) {

    // ── blocked ───────────────────────────────────────────────────────────────

    if (ALWAYS_BLOCKED_TOOLS.has(step.tool)) {
      const call: ExecutionToolCall = {
        id: step.id,
        tool: step.tool,
        input: step.input,
        status: "blocked",
        error: `Tool "${step.tool}" is permanently blocked — this action requires manual execution.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      toolCalls.push(call);
      console.log(`[hermes-execution] BLOCKED tool=${step.tool}`);
      await logRun(req.userId, plan.intent, step.tool, "blocked", call.error);
      return {
        status: "blocked",
        answer: `This action is blocked for safety: "${step.tool}" cannot be executed automatically. Please do it manually.`,
        plan,
        toolCalls,
        artifacts,
      };
    }

    // ── tool missing ──────────────────────────────────────────────────────────

    const tool = getTool(step.tool);
    if (!tool) {
      const call: ExecutionToolCall = {
        id: step.id,
        tool: step.tool,
        input: step.input,
        status: "failed",
        error: `Tool "${step.tool}" is not registered in the execution registry. It may need to be wired up.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      toolCalls.push(call);
      console.error(`[hermes-execution] MISSING tool=${step.tool}`);
      await logRun(req.userId, plan.intent, step.tool, "failed", call.error);
      return {
        status: "failed",
        answer: `Execution stopped: tool "${step.tool}" is not available yet. Check the execution layer setup.`,
        plan,
        toolCalls,
        artifacts,
      };
    }

    // ── approval required ─────────────────────────────────────────────────────

    if (step.requiresApproval || tool.requiresApproval) {
      // For external_write tools, still execute if the tool handles its own
      // approval queuing (like internal.email.createDraft which calls createApproval).
      // The tool returns an approval_required result we surface to the user.
      if (tool.risk === "external_write") {
        const call: ExecutionToolCall = {
          id: step.id,
          tool: step.tool,
          input: step.input,
          status: "approval_required",
          startedAt: new Date().toISOString(),
        };
        toolCalls.push(call);

        try {
          const result = await tool.execute(
            { ...step.input, _previousResults: previousResults },
            ctx
          );
          const res = result as { answer?: string; artifacts?: ExecutionArtifact[] };
          call.status = "completed";
          call.result = result;
          call.completedAt = new Date().toISOString();
          if (res.artifacts) artifacts.push(...res.artifacts);
          await logRun(req.userId, plan.intent, step.tool, "approval_required", res.answer);
          return {
            status: "approval_required",
            answer: res.answer ?? "I can do that, but I need your approval first.",
            plan,
            toolCalls,
            artifacts,
            approval: {
              actionType: step.tool,
              summary: res.answer ?? `Approval needed for ${step.tool}`,
              payload: step.input,
            },
          };
        } catch (err) {
          call.status = "failed";
          call.error = err instanceof Error ? err.message : String(err);
          call.completedAt = new Date().toISOString();
          await logRun(req.userId, plan.intent, step.tool, "failed", call.error);
          // Do NOT return approval_required here — the tool threw before it could
          // create an ApprovalAction row. Returning approval_required would tell
          // the user "pending approval" when nothing is actually in the queue.
          return {
            status: "failed",
            answer: `I tried to queue that for your approval but something went wrong: ${call.error}. Try again or check the Approvals panel.`,
            plan,
            toolCalls,
            artifacts,
          };
        }
      }
    }

    // ── execute ───────────────────────────────────────────────────────────────

    const call: ExecutionToolCall = {
      id: step.id,
      tool: step.tool,
      input: step.input,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    toolCalls.push(call);
    console.log(`[hermes-execution] RUNNING tool=${step.tool} step=${step.id}`);

    try {
      const inputWithPrev = {
        ...step.input,
        // Inject prior step results for dependent steps
        ...(step.dependsOn?.length
          ? {
              _emails: (previousResults[step.dependsOn[0]] as Record<string, unknown>)?._emails,
              _previousResults: previousResults,
            }
          : {}),
      };

      const result = await tool.execute(inputWithPrev, ctx);
      const res = result as { answer?: string; artifacts?: ExecutionArtifact[] };

      call.status = "completed";
      call.result = result;
      call.completedAt = new Date().toISOString();
      previousResults[step.id] = result;

      if (res.artifacts) artifacts.push(...res.artifacts);
      console.log(`[hermes-execution] SUCCESS tool=${step.tool}`);
      await logRun(req.userId, plan.intent, step.tool, "completed", (res.answer ?? "").slice(0, 500));

    } catch (err) {
      call.status = "failed";
      call.error = err instanceof Error ? err.message : String(err);
      call.completedAt = new Date().toISOString();
      console.error(`[hermes-execution] FAILED tool=${step.tool}`, err);
      await logRun(req.userId, plan.intent, step.tool, "failed", call.error);
      return {
        status: "failed",
        answer: `Execution failed at step "${step.tool}": ${call.error}`,
        plan,
        toolCalls,
        artifacts,
      };
    }
  }

  // ── build final answer ────────────────────────────────────────────────────────

  const lastResult = previousResults[plan.steps[plan.steps.length - 1]?.id ?? ""];
  const lastAnswer = (lastResult as { answer?: string })?.answer ?? "Done.";

  return {
    status: "completed",
    answer: lastAnswer,
    plan,
    toolCalls,
    artifacts,
  };
}

// ── logging (reuses existing AgentRun table) ──────────────────────────────────

async function logRun(
  _userId: string,
  intent: string,
  tool: string,
  status: string,
  output?: string
): Promise<void> {
  try {
    await prisma.agentRun.create({
      data: {
        agentName: "hermes-execution",
        inputSummary: `intent=${intent} tool=${tool}`,
        outputSummary: (output ?? "").slice(0, 2000),
        modelProvider: "none",
        status,
      },
    });
  } catch {
    // Logging failure should never break execution
  }
}
