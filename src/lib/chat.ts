import { prisma } from "@/lib/db";
import { routeMessage, routeToAgent, type RouteResult } from "@/agents/hermes";

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
  targetAgent: string | null = null
): Promise<{ userMessage: ChatMessageView; reply: ChatMessageView; route: RouteResult }> {
  const userRow = await prisma.chatMessage.create({
    data: { userId, role: "user", content: text, channel, targetAgent },
  });

  const route = targetAgent
    ? await routeToAgent(userId, targetAgent, text, channel)
    : await routeMessage(userId, text, channel);

  const replyRow = await prisma.chatMessage.create({
    data: { userId, role: "assistant", content: route.reply, channel, targetAgent },
  });

  return { userMessage: toView(userRow), reply: toView(replyRow), route };
}
