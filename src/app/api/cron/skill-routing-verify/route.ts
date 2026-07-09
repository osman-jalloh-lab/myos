import { prisma } from "@/lib/db";
import { sendMessage } from "@/lib/chat";
import { cronGuard } from "@/lib/cron-auth";

type TelemetryRow = {
  skillId: string;
  skillName: string;
  agentName: string | null;
  taskType: string;
  confidence: number | bigint;
  reason: string;
  modelCallAvoided: number | bigint;
  createdAt: string | Date;
};

type RunEventRow = {
  message: string;
  safeDetails: string | null;
  createdAt: string | Date;
};

async function latestTelemetry(userId: string, skillId: string): Promise<TelemetryRow | null> {
  const rows = await prisma.$queryRawUnsafe<TelemetryRow[]>(
    `SELECT skillId, skillName, agentName, taskType, confidence, reason, modelCallAvoided, createdAt
     FROM SkillUsageTelemetry
     WHERE userId = ? AND skillId = ?
     ORDER BY createdAt DESC
     LIMIT 1`,
    userId,
    skillId,
  ).catch(() => []);
  return rows[0] ?? null;
}

async function latestSkillEvent(userId: string): Promise<RunEventRow | null> {
  const rows = await prisma.$queryRawUnsafe<RunEventRow[]>(
    `SELECT e.message, e.safeDetails, e.createdAt
     FROM ExecutionTraceEvent e
     INNER JOIN ExecutionRun r ON r.id = e.runId
     WHERE r.userId = ? AND e.message LIKE 'Skills used:%'
     ORDER BY e.createdAt DESC
     LIMIT 1`,
    userId,
  ).catch(() => []);
  return rows[0] ?? null;
}

function telemetryView(row: TelemetryRow | null) {
  if (!row) return null;
  return {
    skillId: row.skillId,
    skillName: row.skillName,
    agentName: row.agentName,
    taskType: row.taskType,
    confidence: Number(row.confidence),
    reason: row.reason,
    modelCallAvoided: Boolean(Number(row.modelCallAvoided)),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
  };
}

export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const matchedPrompt = "HR sent me an I-9 and E-Verify work authorization question for a new hire. What should I do?";
  const noMatchPrompt = "blue triangle moon pebble qxzv";

  const matched = await sendMessage(user.id, matchedPrompt, "dashboard", "themis");
  const matchedTelemetry = await latestTelemetry(user.id, "i9-hr-compliance-specialist");
  const matchedEvent = await latestSkillEvent(user.id);

  const noMatch = await sendMessage(user.id, noMatchPrompt, "dashboard", null);
  const noMatchTelemetry = await latestTelemetry(user.id, "none");
  const noMatchEvent = await latestSkillEvent(user.id);

  const matchedReply = matched.reply.content;
  const noMatchReply = noMatch.reply.content;
  const ok = /Skills used:.*i9-hr-compliance-specialist/i.test(matchedReply)
    && Number(matchedTelemetry?.confidence ?? 0) >= 35
    && /Skills used: none matched/i.test(noMatchReply)
    && Boolean(noMatchTelemetry)
    && /Skills used:/i.test(matchedEvent?.message ?? "")
    && /Skills used:/i.test(noMatchEvent?.message ?? "");

  return Response.json({
    ok,
    matched: {
      prompt: matchedPrompt,
      targetAgent: "themis",
      replyExcerpt: matchedReply.slice(0, 1200),
      telemetry: telemetryView(matchedTelemetry),
      runInspectorEvent: matchedEvent,
    },
    noMatch: {
      prompt: noMatchPrompt,
      targetAgent: null,
      replyExcerpt: noMatchReply.slice(0, 1200),
      telemetry: telemetryView(noMatchTelemetry),
      runInspectorEvent: noMatchEvent,
    },
  });
}
