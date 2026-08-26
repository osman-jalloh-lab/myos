import { prisma } from "@/lib/db";
import { sendMessage } from "@/lib/chat";
import { buildContextBlock, updateSessionAfterResponse } from "@/lib/memory-context";
import {
  sendTelegramMessage,
  sendChatAction,
  answerCallbackQuery,
  isFromOwner,
  getTelegramFilePath,
  downloadTelegramFile,
  type InlineButton,
  type TelegramUpdate,
} from "@/lib/telegram";
import { transcribeAudioBuffer } from "@/lib/voice-service";
import type { RouteResult } from "@/agents/hermes";
import { COMMAND_AGENT_PREFIXES } from "@/lib/agent-roster";
import { createTelegramPlanPreview, formatTelegramPlanPreview, telegramPlanButtons, telegramPlanButtonsForApproval } from "@/lib/orchestration/telegram-planner";
import { getApproval, markApprovalAwaitingRevision, findApprovalAwaitingRevision, supersedeApproval } from "@/lib/approvals";
import { sendCouncilMessage } from "@/lib/model-council-chat";
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate, type TelegramUpdateType } from "@/lib/telegram-idempotency";

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
  "/tools":      "what external tools are connected",
  "/help":       "list what you can help with",
};

// Agent shortcut prefixes: "/iris what's in my inbox today" → ask iris ...
// "/mercury find me a flight to Atlanta" → Mercury external tool agent
function resolveCommandText(raw: string): { text: string; targetAgent: string | null } {
  const lower = raw.toLowerCase().trim();

  // /agent message → route directly to that agent
  for (const agent of COMMAND_AGENT_PREFIXES) {
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

// Safe, clear natural-language planning intent — mirrors "/plan <request>" but
// without the slash. Deliberately conservative: only fires on an explicit
// "plan ... don't/do not build/execute/run it yet" shape so a normal message
// like "plan my day" never accidentally skips execution.
const NATURAL_PLAN_ONLY = /^(?:please\s+)?plan\s+.+\b(?:do(?:n'?t| not)\s+(?:build|execute|run|start|implement)\s+it\s+yet|not\s+(?:yet|now)\b)/i;

function approvalButtons(route: RouteResult): InlineButton[][] | undefined {
  if (!route.pendingApprovals?.length) return undefined;
  return route.pendingApprovals.map((p) => [
    { text: `✅ Approve ${p.actionType} (${p.id.slice(0, 8)})`, callback_data: `approve ${p.id}` },
    { text: `❌ Reject`, callback_data: `reject ${p.id}` },
  ]);
}

async function runPlanPreview(userId: string, chatId: number, planningText: string, updateId?: number): Promise<void> {
  if (!planningText) {
    await sendTelegramMessage(chatId, "Tell me what you want planned. Execution has not started.");
    return;
  }
  const preview = await createTelegramPlanPreview(userId, String(chatId), planningText, updateId);
  await sendTelegramMessage(chatId, formatTelegramPlanPreview(preview), telegramPlanButtons(preview));
}

/** Ask Council on a pending plan's objective — concise Telegram summary, full deliberation stays in My OS Trace. */
async function runPlanCouncil(userId: string, chatId: number, approvalId: string): Promise<void> {
  const approval = await getApproval(userId, approvalId);
  if (!approval || approval.status !== "pending") {
    await sendTelegramMessage(chatId, "That plan is no longer pending.");
    return;
  }
  const payload = approval.payload as { objective?: string };
  const objective = payload.objective ?? "";
  await sendChatAction(chatId, "typing");
  const result = await sendCouncilMessage({ userId, message: objective, mode: "council" });
  const synthesis = result.councilResult?.synthesis;
  const lines = synthesis
    ? [
        `Council (${result.councilResult!.selection.domain}) — disagreement: ${synthesis.disagreement}, confidence: ${synthesis.confidence}`,
        "",
        ...synthesis.positions.map((p) => `• ${p.participant}: ${p.position}`),
        "",
        `Recommendation: ${synthesis.recommendation}`,
      ]
    : ["Council could not be reached."];
  await sendTelegramMessage(chatId, lines.join("\n"), telegramPlanButtonsForApproval(approvalId));
}

/**
 * Flags the pending plan as awaiting a revision reply. The original stays
 * "pending" (buttons still work) until the user's next text message arrives —
 * at that point runPlanRevisionReply() supersedes it atomically with creating
 * the updated proposal, so it's never briefly both stale and approvable.
 */
async function runPlanRevise(userId: string, chatId: number, approvalId: string): Promise<void> {
  const approval = await getApproval(userId, approvalId);
  if (!approval || approval.status !== "pending") {
    await sendTelegramMessage(chatId, "That plan is no longer pending.");
    return;
  }
  await markApprovalAwaitingRevision(userId, approvalId);
  await sendTelegramMessage(chatId, "What would you like to change about this plan? Reply with the change and I'll send an updated proposal.");
}

/**
 * The user's reply to "what would you like to change" — combines the original
 * objective with the requested change, supersedes the old approval (so it can
 * never be Approved after a revision starts), and creates a fresh preview with
 * its own Approve/Revise/Ask Council/Reject buttons.
 */
async function runPlanRevisionReply(userId: string, chatId: number, pending: { id: string; payload: unknown }, revisionText: string, updateId?: number): Promise<void> {
  const payload = pending.payload as { objective?: string };
  const previousObjective = payload.objective ?? "";
  await supersedeApproval(userId, pending.id);
  const combinedObjective = `${previousObjective}\n\nRevision requested: ${revisionText}`;
  await runPlanPreview(userId, chatId, combinedObjective, updateId);
}

async function handleVoiceOrAudio(
  user: { id: string },
  chatId: number,
  file: { file_id: string; mime_type?: string; file_size?: number }
): Promise<{ resultNote: string }> {
  await sendChatAction(chatId, "typing");
  const { filePath, fileSize } = await getTelegramFilePath(file.file_id);
  const downloaded = await downloadTelegramFile(filePath, file.mime_type, file.file_size ?? fileSize);
  const transcript = await transcribeAudioBuffer(downloaded.buffer, downloaded.mimeType);

  const chatIdStr = String(chatId);
  const chatContext = await buildContextBlock(chatIdStr, user.id, transcript).catch(() => "");
  const result = await sendMessage(user.id, transcript, "telegram", null, chatContext || undefined);
  await sendTelegramMessage(chatId, `🎤 "${transcript}"\n\n${result.reply.content}`, approvalButtons(result.route), "HTML");
  await updateSessionAfterResponse(chatIdStr, user.id, transcript).catch(() => {});
  return { resultNote: "voice transcribed and routed" };
}

/**
 * POST /api/telegram/webhook
 *
 * Telegram is the primary live-chat interface for Hermes OS. Every message from
 * Osman routes through the same sendMessage() → routeMessage() chain as the
 * dashboard, with channel="telegram" so responses get Telegram HTML formatting
 * and the Jarvis-flavored system prompt.
 *
 * Every update_id is claimed in TelegramUpdate (durable, survives function
 * restarts) BEFORE any routing/approval/execution work starts, so a Telegram
 * or Vercel retry never re-runs Hermes, re-creates an approval, or double-fires
 * a build.
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

  const updateId = update.update_id;
  const updateType: TelegramUpdateType = update.callback_query
    ? "callback_query"
    : update.message?.voice
    ? "voice"
    : update.message?.audio
    ? "audio"
    : "message";

  // No update_id (should not happen on real Telegram traffic) — process without
  // a durability guarantee rather than dropping it.
  if (updateId === undefined) {
    await processUpdate(update, user);
    return new Response("ok");
  }

  const claim = await claimTelegramUpdate(updateId, updateType);
  if (claim.outcome === "duplicate") {
    console.error(`[telegram webhook] duplicate update_id=${updateId} (status=${claim.status}) — skipping re-run`);
    // Callback queries must still get an ack, or Telegram shows a perpetual spinner.
    if (update.callback_query) await answerCallbackQuery(update.callback_query.id, "Already handled.");
    return new Response("ok");
  }

  try {
    const resultNote = await processUpdate(update, user);
    await completeTelegramUpdate(updateId, resultNote);
  } catch (err) {
    await failTelegramUpdate(updateId, (err as Error).message?.slice(0, 300));
    console.error(`[telegram webhook] update_id=${updateId} processing failed:`, (err as Error).message);
  }

  return new Response("ok");
}

async function processUpdate(update: TelegramUpdate, user: { id: string }): Promise<string> {
  // ── Callback query (inline button tap) ──────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    const raw = cq.data?.trim();
    if (!chatId || !raw) {
      await answerCallbackQuery(cq.id);
      return "callback: no chat/data";
    }

    const planCouncilMatch = raw.match(/^plan_council\s+([a-zA-Z0-9_-]+)/);
    const planReviseMatch = raw.match(/^plan_revise\s+([a-zA-Z0-9_-]+)/);
    if (planCouncilMatch) {
      await answerCallbackQuery(cq.id, "Asking Council…");
      await runPlanCouncil(user.id, chatId, planCouncilMatch[1]);
      return "plan_council";
    }
    if (planReviseMatch) {
      await answerCallbackQuery(cq.id, "Tell me what to change.");
      await runPlanRevise(user.id, chatId, planReviseMatch[1]);
      return "plan_revise";
    }

    await sendChatAction(chatId, "typing");
    const chatIdStr = String(chatId);
    const chatContext = await buildContextBlock(chatIdStr, user.id, raw).catch(() => "");
    const result = await sendMessage(user.id, raw, "telegram", null, chatContext || undefined);
    await answerCallbackQuery(cq.id, result.route.reply.slice(0, 180));
    await sendTelegramMessage(chatId, result.reply.content, approvalButtons(result.route), "HTML");
    await updateSessionAfterResponse(chatIdStr, user.id, raw).catch(() => {});
    return "callback: routed";
  }

  const chatId = update.message?.chat.id;
  if (!chatId) return "no chat id";

  // ── Voice / audio message ────────────────────────────────────────────────────
  const voiceOrAudio = update.message?.voice ?? update.message?.audio;
  if (voiceOrAudio) {
    try {
      const { resultNote } = await handleVoiceOrAudio(user, chatId, voiceOrAudio);
      return resultNote;
    } catch (err) {
      console.error(`[telegram webhook] voice handling failed:`, (err as Error).message);
      await sendTelegramMessage(chatId, "I couldn't process that voice message — it may be too large, an unsupported format, or transcription failed. Try again or send it as text.").catch(() => {});
      return `voice failed: ${(err as Error).message}`;
    }
  }

  // ── Plain text message ───────────────────────────────────────────────────────
  const rawText = update.message?.text?.trim();
  if (!rawText) return "no text";

  // Fire typing indicator immediately — Osman's phone sees "typing..." while
  // we route the request. This is the single biggest feel change.
  await sendChatAction(chatId, "typing");

  // Capture reply context: when Osman taps "Reply" on a notification, inject
  // the quoted message as a context prefix so Hermes knows what he's replying to.
  const replyToText = update.message?.reply_to_message?.text;
  const contextPrefix = replyToText
    ? `[Context — replying to: "${replyToText.slice(0, 300)}"]\n`
    : "";

  // A pending "Revise" request takes priority over everything else except an
  // explicit slash command — the user's very next free-text message is the
  // revision, not a new unrelated instruction.
  if (!rawText.startsWith("/")) {
    const awaitingRevision = await findApprovalAwaitingRevision(user.id).catch(() => null);
    if (awaitingRevision) {
      await runPlanRevisionReply(user.id, chatId, awaitingRevision, rawText, update.update_id);
      return "plan revised";
    }
  }

  const { text: resolvedText, targetAgent } = resolveCommandText(rawText);
  const fullText = contextPrefix + resolvedText;

  // Explicit "/plan <request>" or clear natural-language plan-only intent both
  // stay in this read-only branch — no chat router, tools, approvals, or queues.
  const explicitPlanMatch = /^\/plan\s+/i.test(rawText);
  const naturalPlanOnly = !explicitPlanMatch && NATURAL_PLAN_ONLY.test(rawText);
  if (explicitPlanMatch || naturalPlanOnly) {
    const planningText = rawText.replace(/^\/plan\s+/i, "").trim();
    await runPlanPreview(user.id, chatId, planningText, update.update_id);
    return "plan preview";
  }

  // Build memory context block before the LLM call — session, active project, recent messages.
  // Failures are non-fatal: a missing context block degrades gracefully to stateless behavior.
  const chatIdStr = String(chatId);
  const chatContext = await buildContextBlock(chatIdStr, user.id, fullText).catch(() => "");

  try {
    const result = await sendMessage(user.id, fullText, "telegram", targetAgent, chatContext || undefined);
    await sendTelegramMessage(chatId, result.reply.content, approvalButtons(result.route), "HTML");
    // Update session goal and maybe trigger summarization after a successful reply
    await updateSessionAfterResponse(chatIdStr, user.id, fullText).catch(() => {});
    return "text: routed";
  } catch (err) {
    console.error(`[telegram webhook] reply failed:`, (err as Error).message);
    // Best-effort fallback — send plain error note so Osman knows something broke
    try {
      await sendTelegramMessage(chatId, "Something went wrong on my end. Check Vercel logs.");
    } catch { /* nothing more to do */ }
    throw err;
  }
}
