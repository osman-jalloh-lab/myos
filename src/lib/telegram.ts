// Thin wrapper over the Telegram Bot HTTP API — no SDK needed for the handful
// of calls this bridge makes. Single-user system: every inbound update is
// checked against TELEGRAM_OWNER_CHAT_ID before anything runs (see webhook route).

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

export interface InlineButton {
  text: string;
  callback_data: string;
}

function requireApiBase(): string {
  if (!API_BASE) throw new Error("TELEGRAM_BOT_TOKEN is not set — Telegram bridge is disabled.");
  return API_BASE;
}

/**
 * Converts LLM markdown output to Telegram HTML.
 * Telegram supports a strict subset: <b>, <i>, <code>, <pre>, <a href>.
 * Must escape raw &, <, > before applying tags.
 */
export function toTelegramHtml(text: string): string {
  // Escape entities first so we don't double-encode tags we add below
  let out = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks → <pre>
  out = out.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_m, code: string) =>
    `<pre>${code.trim()}</pre>`
  );
  // Inline code → <code>
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // **bold** → <b>
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // *italic* → <i>
  out = out.replace(/\*(.+?)\*/g, "<i>$1</i>");
  // ## Headings → <b>
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Collapse 3+ blank lines
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Splits text at paragraph or sentence boundaries to stay within Telegram's
 * 4096-char message limit. Returns an array of chunks.
 */
function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Try to break at a paragraph boundary
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf(". ", limit);
    if (cut < 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  buttons?: InlineButton[][],
  parseMode?: "HTML"
): Promise<void> {
  const base = requireApiBase();
  const chunks = splitMessage(text);

  for (let i = 0; i < chunks.length; i++) {
    // Only attach buttons to the last chunk
    const isLast = i === chunks.length - 1;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
    };
    if (parseMode) body.parse_mode = parseMode;
    if (isLast && buttons) body.reply_markup = { inline_keyboard: buttons };

    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // If HTML parse fails (e.g. malformed tags), retry as plain text
      if (parseMode === "HTML" && res.status === 400) {
        const plain: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
        if (isLast && buttons) plain.reply_markup = { inline_keyboard: buttons };
        await fetch(`${base}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(plain),
        });
      } else {
        throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${errBody.slice(0, 200)}`);
      }
    }
  }
}

/**
 * Sends a "bot is typing" indicator. Non-fatal — if it fails the message still sends.
 * Call this immediately when a user message arrives, before any async work.
 */
export async function sendChatAction(
  chatId: string | number,
  action: "typing" | "upload_document" = "typing"
): Promise<void> {
  if (!API_BASE) return;
  await fetch(`${API_BASE}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  }).catch(() => {}); // non-fatal
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const base = requireApiBase();
  await fetch(`${base}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text, show_alert: false } : {}) }),
  });
}

export async function setTelegramWebhook(url: string, secretToken: string): Promise<{ ok: boolean; description?: string }> {
  const base = requireApiBase();
  const res = await fetch(`${base}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] }),
  });
  return res.json();
}

export async function getWebhookInfo(): Promise<{ url: string; has_custom_certificate: boolean; pending_update_count: number }> {
  const base = requireApiBase();
  const res = await fetch(`${base}/getWebhookInfo`);
  const data = await res.json() as { ok: boolean; result: { url: string; has_custom_certificate: boolean; pending_update_count: number } };
  return data.result;
}

// Checks if the webhook is registered to the expected URL and registers it if not.
// Safe to call on every cron tick — only calls setWebhook when registration is missing or wrong.
export async function ensureWebhookRegistered(expectedUrl: string): Promise<void> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return; // can't register without a secret
  try {
    const info = await getWebhookInfo();
    if (info.url === expectedUrl) return; // already correct
    await setTelegramWebhook(expectedUrl, secret);
  } catch {
    // non-fatal — cron still runs even if registration fails
  }
}

// ── Inbound update shapes (only the fields we read) ──────────────────────────

export interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    /** Populated when Osman taps "Reply" on a bot message — gives Hermes context. */
    reply_to_message?: { text?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

export function isFromOwner(update: TelegramUpdate, ownerChatId: string): boolean {
  const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
  return senderId !== undefined && String(senderId) === ownerChatId;
}
