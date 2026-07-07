import { prisma } from "@/lib/db";
import { routeMessage, routeToAgent, type RouteResult } from "@/agents/hermes";
import { handleMercuryRequest } from "@/agents/mercury";
import { autoCaptureUserMemory, logAutoMemoryFailure, rememberedTag } from "@/lib/auto-memory";
import { buildContextBlock, updateSessionAfterResponse } from "@/lib/memory-context";
import { contextStateFromContextBlock, resolveMessageWithContext } from "@/lib/context-persistence";

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
  const userRow = await prisma.chatMessage.create({
    data: { userId, role: "user", content: text, channel, targetAgent },
  });
  const remembered = await autoCaptureUserMemory(userId, text).catch(async (error) => {
    await logAutoMemoryFailure(userId, text, error);
    return [] as string[];
  });
  const resolvedContext = chatContext ?? await buildContextBlock(contextChatId, userId, text).catch(() => "");
  const contextResolution = resolveMessageWithContext(text, contextStateFromContextBlock(resolvedContext || undefined));
  const routingText = contextResolution.resolvedText;

  let route: RouteResult;
  if (targetAgent === "mercury") {
    // Mercury handles external tool/API requests independently — it does not
    // go through Hermes routing, keeping the two agent graphs separate.
    const { reply, pendingApprovals } = await handleMercuryRequest(userId, routingText, channel);
    route = { reply, pendingApprovals };
  } else {
    route = targetAgent
      ? await routeToAgent(userId, targetAgent, routingText, channel, 0, resolvedContext || undefined)
      : await routeMessage(userId, routingText, channel, resolvedContext || undefined);
  }

  // Instant feedback when a fact auto-saved, so Osman never wonders whether it landed.
  const memoryTag = rememberedTag(remembered);
  if (memoryTag) route.reply = `${route.reply}\n\n${memoryTag}`;

  const replyRow = await prisma.chatMessage.create({
    data: { userId, role: "assistant", content: route.reply, channel, targetAgent },
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
