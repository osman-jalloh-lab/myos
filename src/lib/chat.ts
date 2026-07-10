import { prisma } from "@/lib/db";
import { routeMessage, routeToAgent, type RouteResult } from "@/agents/hermes";
import { handleMercuryRequest } from "@/agents/mercury";
import { autoCaptureUserMemory, logAutoMemoryFailure, rememberedTag } from "@/lib/auto-memory";
import { buildContextBlock, updateSessionAfterResponse } from "@/lib/memory-context";
import { contextStateFromContextBlock, resolveMessageWithContext } from "@/lib/context-persistence";
import { normalizeAgentKey } from "@/lib/agent-roster";
import { isCouncilProviderTarget, providerFamilyFromCouncilTarget, sendCouncilMessage } from "@/lib/model-council-chat";
import { appendExecutionEvent, createExecutionRun } from "@/lib/execution-runs";
import {
  formatSkillsUsed,
  recordSkillUsageTelemetry,
  resolveRelevantSkills,
  skillInstructionBlock,
  type SkillResolution,
} from "@/lib/skills/routing";
import { retrieveMemoryForPrompt, type MemoryRetrievalResult } from "@/lib/memory-center";

export type ChatChannel = "dashboard" | "telegram";

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: ChatChannel;
  targetAgent: string | null;
  createdAt: string;
}

function toView(row: {
  id: string;
  role: string;
  content: string;
  channel: string;
  targetAgent: string | null;
  createdAt: Date;
}): ChatMessageView {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    channel: row.channel === "telegram" ? "telegram" : "dashboard",
    targetAgent: row.targetAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

function memoryRetrievalBlock(result: MemoryRetrievalResult | null): string | null {
  if (!result) return null;
  const lines: string[] = [];
  if (result.confirmedFacts.length > 0) {
    lines.push("RETRIEVED CONFIRMED MEMORY");
    lines.push(...result.confirmedFacts.map((item) => `- ${item.fact}${item.source ? ` (source: ${item.source}, confidence: ${item.confidence}%)` : ` (confidence: ${item.confidence}%)`}`));
  }
  if (result.projectDecisions.length > 0) {
    lines.push("RETRIEVED PROJECT DECISIONS");
    lines.push(...result.projectDecisions.map((item) => `- ${item.projectName}: ${item.decision.slice(0, 260)} (source: ${item.source}, confidence: ${item.confidence}%)`));
  }
  if (result.redactedCount > 0) lines.push(`Sensitive memory redactions applied: ${result.redactedCount}.`);
  return lines.length ? lines.join("\n") : null;
}

/**
 * Thread history. `targetAgent: null` (the default) returns the general Hermes
 * thread; passing an agent name returns that agent's private thread only —
 * each agent gets its own independent conversation log.
 */
export async function chatHistory(userId: string, limit = 50, targetAgent: string | null = null): Promise<ChatMessageView[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { userId, targetAgent },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toView).reverse();
}

/**
 * All traffic on one channel, regardless of which agent thread it belongs to.
 * Used by the dashboard's Telegram mirror panel — every message Osman sends
 * from his phone (and every bot reply) is persisted with channel "telegram"
 * by the webhook, so reading them back here requires no new write path.
 */
export async function channelHistory(userId: string, channel: ChatChannel, limit = 30): Promise<ChatMessageView[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { userId, channel },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toView).reverse();
}

/**
 * Persists the user's message, routes it, persists the reply, and returns
 * both. This is the single function both the dashboard chat API and the
 * Telegram webhook call — one place where "send a message" is defined,
 * regardless of which surface it came from.
 *
 * When `targetAgent` is set, the message goes to that agent's private thread
 * via Hermes.routeToAgent() (the agent answers in its own voice from its own
 * read tools) instead of the general Hermes.routeMessage() intent router.
 */
export async function sendMessage(
  userId: string,
  text: string,
  channel: ChatChannel = "dashboard",
  targetAgent: string | null = null,
  chatContext?: string
): Promise<{ userMessage: ChatMessageView; reply: ChatMessageView; route: RouteResult }> {
  const contextChatId = `${channel}:shared:${userId}`;
  const normalizedTargetAgent = targetAgent ? normalizeAgentKey(targetAgent) : null;
  if (channel === "dashboard" && isCouncilProviderTarget(normalizedTargetAgent)) {
    const providerFamily = providerFamilyFromCouncilTarget(normalizedTargetAgent!);
    if (!providerFamily) throw new Error("Unknown Council provider.");
    return sendCouncilMessage({
      userId,
      message: text,
      mode: "provider",
      providerFamily,
    });
  }
  const userRow = await prisma.chatMessage.create({
    data: { userId, role: "user", content: text, channel, targetAgent: normalizedTargetAgent },
  });
  const remembered = await autoCaptureUserMemory(userId, text).catch(async (error) => {
    await logAutoMemoryFailure(userId, text, error);
    return [] as string[];
  });
  const resolvedContext = chatContext ?? await buildContextBlock(contextChatId, userId, text).catch(() => "");
  const contextResolution = resolveMessageWithContext(text, contextStateFromContextBlock(resolvedContext || undefined));
  const routingText = contextResolution.resolvedText;
  const contextProject = contextResolution as unknown as { projectId?: unknown };
  const projectId = typeof contextProject.projectId === "string"
    ? contextProject.projectId
    : null;
  const skillResolution = await resolveRelevantSkills({
    userId,
    message: routingText,
    agentName: normalizedTargetAgent,
    projectId,
    maxSkills: 3,
  }).catch((): SkillResolution => ({
    matched: false,
    agentName: normalizedTargetAgent ?? "hermes",
    projectId,
    taskType: "general",
    confidence: 0,
    reason: "Skill routing could not inspect the registry, so the normal agent/model path was used.",
    skills: [],
    consideredSkillCount: 0,
    primarySkill: null,
    supportingSkills: [],
    rejectedSkills: [],
    qualityWarnings: [],
    missingContextQuestions: [],
    explanation: "Skill routing failed before a v2 explanation could be generated.",
  }));
  const run = await createExecutionRun({
    userId,
    projectId,
    executor: "internal",
    currentPhase: "planning",
    currentActivity: "Retrieving relevant memory and project decisions.",
  }).catch(() => null);
  const memoryRetrieval = await retrieveMemoryForPrompt({
    userId,
    message: routingText,
    agentName: skillResolution.agentName,
    taskType: skillResolution.taskType,
    projectId,
    runId: run?.id ?? null,
    maxFacts: 6,
  }).catch((): MemoryRetrievalResult | null => null);
  if (run) {
    await appendExecutionEvent(run.id, {
      phase: "planning",
      source: "web",
      severity: "info",
      message: memoryRetrieval
        ? `Memory retrieved: ${memoryRetrieval.confirmedFacts.length} confirmed facts, ${memoryRetrieval.projectDecisions.length} project decisions.`
        : "Memory retrieved: unavailable; normal routing continued.",
      safeDetails: {
        confirmedFacts: memoryRetrieval?.confirmedFacts ?? [],
        projectDecisions: memoryRetrieval?.projectDecisions ?? [],
        redactedCount: memoryRetrieval?.redactedCount ?? 0,
      },
      meaningful: true,
    });
  }
  const memoryBlock = memoryRetrievalBlock(memoryRetrieval);
  const skillBlock = skillInstructionBlock(skillResolution);
  const preface = [memoryBlock, skillBlock].filter(Boolean).join("\n\n");
  const routedWithSkills = preface ? `${preface}\n\nUSER MESSAGE\n${routingText}` : routingText;

  let route: RouteResult;
  if (normalizedTargetAgent === "mercury") {
    // Mercury handles external tool/API requests independently — it does not
    // go through Hermes routing, keeping the two agent graphs separate.
    const { reply, pendingApprovals } = await handleMercuryRequest(userId, routedWithSkills, channel);
    route = { reply, pendingApprovals };
  } else {
    route = normalizedTargetAgent
      ? await routeToAgent(userId, normalizedTargetAgent, routedWithSkills, channel, 0, resolvedContext || undefined)
      : await routeMessage(userId, routedWithSkills, channel, resolvedContext || undefined);
  }

  const skillsUsedLine = formatSkillsUsed(skillResolution);
  route.reply = `${route.reply}\n\n${skillsUsedLine}`;
  await recordSkillUsageTelemetry({ userId, resolution: skillResolution, modelCallAvoided: false }).catch(() => {});
  if (run) {
    await appendExecutionEvent(run.id, {
      phase: "completed",
      source: "web",
      severity: skillResolution.matched ? "info" : "warning",
      message: skillsUsedLine,
      safeDetails: {
        agentName: skillResolution.agentName,
        taskType: skillResolution.taskType,
        confidence: skillResolution.confidence,
        reason: skillResolution.reason,
        explanation: skillResolution.explanation,
        primarySkill: skillResolution.primarySkill ? {
          id: skillResolution.primarySkill.id,
          confidence: skillResolution.primarySkill.confidence,
          quality: skillResolution.primarySkill.skillQualityScore,
        } : null,
        supportingSkills: skillResolution.supportingSkills.map((skill) => ({
          id: skill.id,
          confidence: skill.confidence,
          quality: skill.skillQualityScore,
        })),
        rejectedSkills: skillResolution.rejectedSkills.slice(0, 5),
        missingContextQuestions: skillResolution.missingContextQuestions,
        qualityWarnings: skillResolution.qualityWarnings,
        skills: skillResolution.skills.map((skill) => ({
          id: skill.id,
          confidence: skill.confidence,
          reason: skill.reason,
        })),
      },
      meaningful: true,
      status: "completed",
    });
  }

  // Instant feedback when a fact auto-saved, so Osman never wonders whether it landed.
  const memoryTag = rememberedTag(remembered);
  if (memoryTag) route.reply = `${route.reply}\n\n${memoryTag}`;

  const replyRow = await prisma.chatMessage.create({
    data: { userId, role: "assistant", content: route.reply, channel, targetAgent: normalizedTargetAgent },
  });
  await updateSessionAfterResponse(contextChatId, userId, text).catch(() => {});

  return { userMessage: toView(userRow), reply: toView(replyRow), route };
}

/** Persist an already-executed reply without routing the prompt through Hermes again. */
export async function persistExecutedMessage(userId: string, text: string, reply: string, channel: ChatChannel = "dashboard"): Promise<{ userMessage: ChatMessageView; reply: ChatMessageView }> {
  const remembered = await autoCaptureUserMemory(userId, text).catch(async (error) => {
    await logAutoMemoryFailure(userId, text, error);
    return [] as string[];
  });
  const memoryTag = rememberedTag(remembered);
  if (memoryTag) reply = `${reply}\n\n${memoryTag}`;
  const [userRow, replyRow] = await prisma.$transaction([
    prisma.chatMessage.create({ data: { userId, role: "user", content: text, channel, targetAgent: null } }),
    prisma.chatMessage.create({ data: { userId, role: "assistant", content: reply, channel, targetAgent: null } }),
  ]);
  return { userMessage: toView(userRow), reply: toView(replyRow) };
}
