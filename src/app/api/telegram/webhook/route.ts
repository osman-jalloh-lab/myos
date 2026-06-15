import { prisma } from "@/lib/db";
import { sendMessage } from "@/lib/chat";
import {
  sendTelegramMessage,
  sendChatAction,
  answerCallbackQuery,
  isFromOwner,
  type InlineButton,
  type TelegramUpdate,
} from "@/lib/telegram";
import type { RouteResult } from "@/agents/hermes";

// Bot command shortcuts — map Telegram slash commands to natural-language
// queries so every command fans through the same routeMessage() intent router.
// This means Osman gets the full agent chain, not a hardcoded shortcut.
const BOT_COMMANDS: Record<string, string> = {
  "/start":      "systems online",
  "/brief":      "brief me on today",
  "/b":          "brief me on today",
  "/email":      "triage my inbox",
  "/e":          "triage my inbox",
  "/jobs":       "job tracker status",
  "/j":          "job tracker status",
  "/approvals":  "show pending approvals",
  "/a":          "show pending approvals",
  "/tasks":      "what tasks are pending",
  "/calendar":   "what's on my calendar today and tomorrow",
  "/finance":    "finance snapshot",
  "/help":       "list what you can help with",
};

// Agent shortcut prefixes: "/iris what's in my inbox today" → ask iris ...
const AGENT_PREFIXES = ["iris", "kairos", "athena", "plutus", "argus", "mnemosyne", "sophos", "themis", "tyche"];

function resolveCommandText(raw: string): { text: string; targetAgent: string | null } {
  const lower = raw.toLowerCase().trim();

  // /agent message → route directly to that agent
  for (const agent of AGENT_PREFIXES) {
    if (lower.startsWith(`/${agent} `) || lower.startsWith(`/${agent}\n`)) {
      return { text: raw.slice(agent.length + 2).trim(), targetAgent: agent };
    }
    // Just "/iris" with no message → ask that agent for their standard briefing
    if (lower === `/${agent}`) {
      return { text: "give me your current status", targetAgent: agent };
    }
  }

  // Plain bot command → mapped query text
  const cmdKey = lower.split(" ")[0]; // handle "/brief something" → "/brief"
  if (BOT_COMMANDS[cmdKey]) {
    const extra = raw.slice(cmdKey.length).trim();
    return { text: extra ? `${BOT_COMMANDS[cmdKey]}: ${extra}` : BOT_COMMANDS[cmdKey], targetAgent: null };
  }

  return { text: raw, targetAgent: null };
}

function approvalButtons(route: RouteResult): InlineButton[][] | undefined {
  if (!route.pendingApprovals?.length) return undefined;
  return route.pendingApprovals.map((p) => [
    { text: `✅ Approve ${p.actionType} (${p.id.slice(0, 8)})`, callback_data: `approve ${p.id}` },
    { text: `❌ Reject`, callback_data: `reject ${p.id}` },
  ]);
}

/**
 * POST /api/telegram/webhook
 *
 * Telegram is the primary live-chat interface for Hermes OS. Every message from
 * Osman routes through the same sendMessage() → routeMessage() chain as the
 * dashboard, with channel="telegram" so responses get Telegram HTML formatting
 * and the Jarvis-flavored system prompt.
 *
 * Features added vs the base implementation:
 * - Typing indicator fires immediately before any async work
 * - Bot command shortcuts (/brief, /email, /jobs, /iris, /athena, etc.)
 * - /agent shortcuts bypass Hermes and talk directly to a named agent
 * - Reply context: when Osman taps "Reply" on a notification, the quoted
 *   message text is prepended as context so Hermes knows what he's responding to
 * - Responses use parse_mode: "HTML" for rich formatting
 */
export async function POST(req: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;

  if (!expectedSecret || !ownerChatId) {
    return new Response("Telegram bridge not configured", { status: 503 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update) return new Response("ok");

  if (!isFromOwner(update, ownerChatId)) {
    const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
    console.error(`[telegram webhook] sender ${senderId} != owner — ignoring`);
    return new Response("ok");
  }

  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    console.error("[telegram webhook] no User row yet — sign in on dashboard first");
    return new Response("ok");
  }

  // ── Callback query (inline button tap) ──────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    const raw = cq.data?.trim();
    if (chatId && raw) {
      await sendChatAction(chatId, "typing");
      const result = await sendMessage(user.id, raw, "telegram");
      await answerCallbackQuery(cq.id, result.route.reply.slice(0, 180));
      try {
        await sendTelegramMessage(chatId, result.reply.content, approvalButtons(result.route), "HTML");
      } catch (err) {
        console.error(`[telegram webhook] callback reply failed:`, (err as Error).message);
      }
    } else {
      await answerCallbackQuery(cq.id);
    }
    return new Response("ok");
  }

  // ── Plain text message ───────────────────────────────────────────────────────
  const chatId = update.message?.chat.id;
  const rawText = update.message?.text?.trim();
  if (!chatId || !rawText) return new Response("ok");

  // Fire typing indicator immediately — Osman's phone sees "typing..." while
  // we route the request. This is the single biggest feel change.
  await sendChatAction(chatId, "typing");

  // Capture reply context: when Osman taps "Reply" on a notification, inject
  // the quoted message as a context prefix so Hermes knows what he's replying to.
  const replyToText = update.message?.reply_to_message?.text;
  const contextPrefix = replyToText
    ? `[Context — replying to: "${replyToText.slice(0, 300)}"]\n`
    : "";

  const { text: resolvedText, targetAgent } = resolveCommandText(rawText);
  const fullText = contextPrefix + resolvedText;

  try {
    const result = await sendMessage(user.id, fullText, "telegram", targetAgent);
    await sendTelegramMessage(chatId, result.reply.content, approvalButtons(result.route), "HTML");
  } catch (err) {
    console.error(`[telegram webhook] reply failed:`, (err as Error).message);
    // Best-effort fallback — send plain error note so Osman knows something broke
    try {
      await sendTelegramMessage(chatId, "Something went wrong on my end. Check Vercel logs.");
    } catch { /* nothing more to do */ }
  }

  return new Response("ok");
}
