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

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  buttons?: InlineButton[][]
): Promise<void> {
  const base = requireApiBase();
  const res = await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
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
