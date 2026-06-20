import { prisma } from "./db";
import { getValidToken } from "./tokens";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  labels: string[];
  isUnread: boolean;
  isImportant: boolean;
  accountEmail: string;
  accountLabel: string;
}

export type EmailCategory =
  | "action_needed"
  | "personal"
  | "newsletter"
  | "promotion"
  | "notification";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

function header(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value ?? ""
  );
}

/** Fetches metadata-only messages (no bodies) across all linked accounts. */
export async function fetchInboxMessages(
  userId: string,
  maxPerAccount = 15
): Promise<EmailMessage[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };

      const listParams = new URLSearchParams({
        maxResults: String(maxPerAccount),
        labelIds: "INBOX",
      });
      const listRes = await fetch(`${GMAIL_API}/messages?${listParams}`, { headers });
      if (!listRes.ok) {
        throw new Error(`Gmail list ${listRes.status} for ${account.email}`);
      }
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      const ids = list.messages ?? [];

      const messages = await Promise.allSettled(
        ids.map(async ({ id }) => {
          const params = new URLSearchParams({ format: "metadata" });
          params.append("metadataHeaders", "Subject");
          params.append("metadataHeaders", "From");
          const res = await fetch(`${GMAIL_API}/messages/${id}?${params}`, { headers });
          if (!res.ok) throw new Error(`Gmail get ${res.status} for ${id}`);
          const msg = (await res.json()) as GmailMessage;
          const labels = msg.labelIds ?? [];
          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: header(msg, "Subject") || "(no subject)",
            from: header(msg, "From"),
            snippet: msg.snippet ?? "",
            receivedAt: msg.internalDate
              ? new Date(Number(msg.internalDate)).toISOString()
              : new Date().toISOString(),
            labels,
            isUnread: labels.includes("UNREAD"),
            isImportant: labels.includes("IMPORTANT"),
            accountEmail: account.email,
            accountLabel: account.label,
          } satisfies EmailMessage;
        })
      );

      return messages
        .filter((r): r is PromiseFulfilledResult<EmailMessage> => r.status === "fulfilled")
        .map((r) => r.value);
    })
  );

  const all: EmailMessage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    // Rejected accounts (bad token, network) are silently skipped — same pattern as calendar.ts
  }

  return all.sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );
}

const NEWSLETTER_HINTS = ["unsubscribe", "newsletter", "digest"];
const NOTIFICATION_SENDERS = ["no-reply", "noreply", "notifications@", "notification@"];

// Senders that push marketing, job-spam, or social blasts. These must never be
// treated as action_needed even when Gmail fails to tag them PROMOTIONS/SOCIAL.
// Match is a substring test against the lowercased From header, so a bare domain
// covers all of its subdomains (e.g. "jobcase.com" also catches pmail.jobcase.com).
const LOW_PRIORITY_SENDER_DOMAINS = [
  "jobcase.com",
  "everyjobforme.com",
  "meetup.com",
  "ziprecruiter.com",
  "indeed.com",
  "glassdoor.com",
  "linkedin.com",
  // add new marketing/job-spam domains here as they show up
];

// Optional second signal: manipulative subject patterns common to job-spam and
// social blasts. Used only to demote, never to promote, so a false match just
// moves noise out of the priority list.
const LOW_PRIORITY_SUBJECT_HINTS = [
  "is interested in you",
  "jobs for you",
  "people you may know",
  "just scheduled:",
  "view your matches",
];

/** Heuristic, metadata-only classification — no LLM call needed for Lean Mode. */
export function classify(message: EmailMessage): EmailCategory {
  const labels = message.labels;
  const from = message.from.toLowerCase();
  const subject = message.subject.toLowerCase();
  const snippet = message.snippet.toLowerCase();

  // Demote known marketing / job-spam senders before any action_needed path.
  if (LOW_PRIORITY_SENDER_DOMAINS.some((d) => from.includes(d))) {
    return "promotion";
  }
  if (LOW_PRIORITY_SUBJECT_HINTS.some((h) => subject.includes(h))) {
    return "notification";
  }

  if (labels.includes("CATEGORY_PROMOTIONS")) return "promotion";
  if (labels.includes("CATEGORY_SOCIAL") || labels.includes("CATEGORY_FORUMS")) {
    return "notification";
  }
  if (
    labels.includes("CATEGORY_UPDATES") ||
    NOTIFICATION_SENDERS.some((s) => from.includes(s))
  ) {
    return "notification";
  }
  if (NEWSLETTER_HINTS.some((h) => subject.includes(h) || snippet.includes(h))) {
    return "newsletter";
  }
  if (message.isImportant || labels.includes("CATEGORY_PERSONAL")) {
    return message.isUnread ? "action_needed" : "personal";
  }
  return message.isUnread ? "action_needed" : "personal";
}

export interface TriageResult {
  total: number;
  unread: number;
  byCategory: Record<EmailCategory, EmailMessage[]>;
  needsAttention: EmailMessage[];
}

/** Groups inbox messages by category and surfaces what needs attention first. */
export async function triage(userId: string, maxPerAccount = 15): Promise<TriageResult> {
  const messages = await fetchInboxMessages(userId, maxPerAccount);

  const byCategory: Record<EmailCategory, EmailMessage[]> = {
    action_needed: [],
    personal: [],
    newsletter: [],
    promotion: [],
    notification: [],
  };

  for (const message of messages) {
    byCategory[classify(message)].push(message);
  }

  return {
    total: messages.length,
    unread: messages.filter((m) => m.isUnread).length,
    byCategory,
    needsAttention: byCategory.action_needed,
  };
}

/**
 * Proposes a reply as a pending ApprovalAction — never touches the Gmail API.
 * Iris has no gmail.compose/gmail.send scope; the draft only becomes real once
 * the Phase 4 approval queue exists and a human approves it.
 */
export async function draftReply(
  userId: string,
  params: { messageId: string; threadId: string; to: string; subject: string; body: string }
) {
  const { createApproval } = await import("./approvals");
  return createApproval(userId, "draft_email", params);
}

// ── Thread body fetch — used by Iris for draft replies ────────────────────────

export interface ThreadMessage {
  from: string;
  subject: string;
  date: string;
  body: string;
}

export async function fetchThreadBody(
  userId: string,
  threadId: string
): Promise<ThreadMessage[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true },
  });

  for (const account of accounts) {
    try {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };
      const res = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, { headers });
      if (!res.ok) continue;

      const thread = (await res.json()) as { messages?: GmailFullMessage[] };
      const messages = thread.messages ?? [];

      return messages.map((msg) => {
        const h = (name: string) =>
          msg.payload?.headers?.find((hdr) => hdr.name.toLowerCase() === name.toLowerCase())?.value ?? "";
        const body = msg.payload ? extractBodyFromPart(msg.payload as GmailMessagePart) : "";
        return {
          from: h("from"),
          subject: h("subject"),
          date: h("date"),
          body: body.slice(0, 3000),
        };
      });
    } catch {
      continue;
    }
  }
  return [];
}

// ── Job Scout: full-body email fetch ─────────────────────────────────────────
// Queries job-alert senders only (allowlist), fetches full message body for
// LLM parsing, and filters out newsletters/promos. Used by the daily
// job-scout-gmail cron — entirely separate from the Iris triage path.

export const JOB_ALERT_SENDERS = [
  "jobs-noreply@linkedin.com",
  "jobalerts@indeed.com",
  "alert@glassdoor.com",
  "apply@ziprecruiter.com",
  "noreply@handshake.com",
  "jobs@simplyhired.com",
  "alerts@monster.com",
  "no-reply@glassdoor.com",
];

export interface EmailWithBody extends EmailMessage {
  body: string; // plain text, HTML stripped, max 8000 chars
}

interface GmailFullPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailFullMessage extends Omit<GmailMessage, "payload"> {
  payload?: GmailFullPayload;
}

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

function extractBodyFromPart(part: GmailMessagePart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const p of part.parts) {
      if (p.mimeType === "text/plain" && p.body?.data) {
        return decodeBase64Url(p.body.data);
      }
    }
    for (const p of part.parts) {
      if (p.mimeType === "text/html" && p.body?.data) {
        return stripHtml(decodeBase64Url(p.body.data));
      }
    }
    for (const p of part.parts) {
      const body = extractBodyFromPart(p);
      if (body) return body;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }
  return "";
}

// ── Application Tracker: broad job email search ───────────────────────────────
// Distinct from fetchJobAlertMessages (which uses a sender allowlist for job
// alerts). This searches Gmail full-text for evidence of actual applications —
// phrases like "thank you for applying", "still interested", "interview", etc.
// across ANY sender, so it catches recruiter replies, confirmation emails, etc.

const APP_TRACKER_QUERY_PHRASES = [
  '"thank you for applying"',
  '"application received"',
  '"your application"',
  '"we received your application"',
  '"still interested"',
  '"are you still interested"',
  '"next steps"',
  '"phone screen"',
  '"video interview"',
  '"hiring team"',
];

export interface AppEmail extends EmailMessage {
  body: string; // plain text, HTML stripped, max 6000 chars
}

/**
 * Searches all linked Gmail accounts for job application evidence going back
 * `daysBack` days. Fetches full bodies for LLM extraction. Used by the app
 * tracker backfill and daily sweep — separate from the job-scout pipeline.
 */
export async function fetchApplicationEmails(
  userId: string,
  daysBack: number = 2,
  maxPerAccount = 50
): Promise<AppEmail[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  // Build a broad OR query across all detection phrases
  const phraseQuery = APP_TRACKER_QUERY_PHRASES.join(" OR ");
  const query = `(${phraseQuery}) newer_than:${daysBack}d -label:CATEGORY_PROMOTIONS -label:CATEGORY_SOCIAL`;

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };

      const listParams = new URLSearchParams({ maxResults: String(maxPerAccount), q: query });
      const listRes = await fetch(`${GMAIL_API}/messages?${listParams}`, { headers });
      if (!listRes.ok) return [];
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      const ids = list.messages ?? [];

      const messages = await Promise.allSettled(
        ids.map(async ({ id }) => {
          const res = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers });
          if (!res.ok) throw new Error(`Gmail get ${res.status} for ${id}`);
          const msg = (await res.json()) as GmailFullMessage;

          const payload = msg.payload;
          let body = "";
          if (payload) {
            if (payload.body?.data) {
              const raw = decodeBase64Url(payload.body.data);
              body = payload.mimeType === "text/html" ? stripHtml(raw) : raw;
            } else if (payload.parts) {
              body = extractBodyFromPart({ mimeType: payload.mimeType ?? "", parts: payload.parts });
            }
          }

          const labels = msg.labelIds ?? [];
          const getHeader = (name: string) =>
            payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: getHeader("Subject") || "(no subject)",
            from: getHeader("From"),
            snippet: msg.snippet ?? "",
            receivedAt: msg.internalDate
              ? new Date(Number(msg.internalDate)).toISOString()
              : new Date().toISOString(),
            labels,
            isUnread: labels.includes("UNREAD"),
            isImportant: labels.includes("IMPORTANT"),
            accountEmail: account.email,
            accountLabel: account.label,
            body: body.slice(0, 6000),
          } satisfies AppEmail;
        })
      );

      return messages
        .filter((r): r is PromiseFulfilledResult<AppEmail> => r.status === "fulfilled")
        .map((r) => r.value);
    })
  );

  const all: AppEmail[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}

/**
 * Fetches full-body job-alert emails from the last 24 hours across all linked
 * accounts. Only returns messages from the JOB_ALERT_SENDERS allowlist.
 * Used exclusively by the job-scout-gmail pipeline — not Iris.
 */
export async function fetchJobAlertMessages(
  userId: string,
  maxPerAccount = 20
): Promise<EmailWithBody[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  const senderQuery = JOB_ALERT_SENDERS.map((s) => `from:${s}`).join(" OR ");
  const query = `(${senderQuery}) newer_than:1d -label:CATEGORY_PROMOTIONS`;

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };

      const listParams = new URLSearchParams({
        maxResults: String(maxPerAccount),
        q: query,
      });
      const listRes = await fetch(`${GMAIL_API}/messages?${listParams}`, { headers });
      if (!listRes.ok) return [];
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      const ids = list.messages ?? [];

      const messages = await Promise.allSettled(
        ids.map(async ({ id }) => {
          const res = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers });
          if (!res.ok) throw new Error(`Gmail get ${res.status} for ${id}`);
          const msg = (await res.json()) as GmailFullMessage;

          const payload = msg.payload;
          let body = "";
          if (payload) {
            if (payload.body?.data) {
              const raw = decodeBase64Url(payload.body.data);
              body = payload.mimeType === "text/html" ? stripHtml(raw) : raw;
            } else if (payload.parts) {
              body = extractBodyFromPart({ mimeType: payload.mimeType ?? "", parts: payload.parts });
            }
          }

          const labels = msg.labelIds ?? [];
          const getHeader = (name: string) =>
            payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: getHeader("Subject") || "(no subject)",
            from: getHeader("From"),
            snippet: msg.snippet ?? "",
            receivedAt: msg.internalDate
              ? new Date(Number(msg.internalDate)).toISOString()
              : new Date().toISOString(),
            labels,
            isUnread: labels.includes("UNREAD"),
            isImportant: labels.includes("IMPORTANT"),
            accountEmail: account.email,
            accountLabel: account.label,
            body: body.slice(0, 8000),
          } satisfies EmailWithBody;
        })
      );

      return messages
        .filter((r): r is PromiseFulfilledResult<EmailWithBody> => r.status === "fulfilled")
        .map((r) => r.value);
    })
  );

  const all: EmailWithBody[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
}

// ── Thread staleness scanner ──────────────────────────────────────────────────
// Finds threads where a real human sent the last message and Osman hasn't
// replied yet. Used by the thread-watcher cron to surface "waiting on you"
// threads before they go cold.

export interface OpenThread {
  threadId: string;
  subject: string;
  lastFrom: string;
  lastSnippet: string;
  lastMessageId: string;
  lastReceivedAt: string; // ISO timestamp
  hoursSinceLastMessage: number;
  accountEmail: string;
  accountLabel: string;
}

const OSMAN_EMAILS = [
  "osman.jalloh@g.austincc.edu",
  "osmanjalloh104@gmail.com",
  "osman.jalloh@austincc.edu",
];

const AUTOMATED_PATTERNS = [
  "noreply", "no-reply", "notification", "notifications@", "do-not-reply",
  "donotreply", "mailer", "newsletter", "digest", "alert@", "alerts@",
  "jobs-noreply", "jobalerts", "bounce@", "automated@", "info@", "hello@",
  "updates@", "support@", "team@",
];

function isAutomated(from: string): boolean {
  const lower = from.toLowerCase();
  return AUTOMATED_PATTERNS.some((p) => lower.includes(p));
}

function isOsman(from: string): boolean {
  const lower = from.toLowerCase();
  return OSMAN_EMAILS.some((e) => lower.includes(e));
}

interface GmailThreadMessage {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

interface GmailThread {
  id: string;
  snippet?: string;
  messages?: GmailThreadMessage[];
}

/**
 * Scans all linked Gmail accounts for threads where a real human sent the
 * last message more than `staleAfterHours` hours ago and Osman hasn't replied.
 * These are threads that risk going cold without a nudge.
 */
export async function fetchOpenThreads(
  userId: string,
  staleAfterHours = 24,
  lookbackDays = 14,
  maxPerAccount = 30
): Promise<OpenThread[]> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true },
  });

  const now = Date.now();
  const staleMs = staleAfterHours * 60 * 60 * 1000;

  // Broad search: recent inbox threads, excluding obvious noise categories
  const query = `is:inbox newer_than:${lookbackDays}d -label:CATEGORY_PROMOTIONS -label:CATEGORY_SOCIAL -label:CATEGORY_FORUMS`;

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };

      const listParams = new URLSearchParams({ maxResults: String(maxPerAccount), q: query });
      const listRes = await fetch(`${GMAIL_API}/threads?${listParams}`, { headers });
      if (!listRes.ok) return [];
      const list = (await listRes.json()) as { threads?: { id: string }[] };
      const threadIds = list.threads ?? [];

      const threads = await Promise.allSettled(
        threadIds.map(async ({ id }) => {
          const params = new URLSearchParams({ format: "metadata" });
          params.append("metadataHeaders", "From");
          params.append("metadataHeaders", "Subject");
          const res = await fetch(`${GMAIL_API}/threads/${id}?${params}`, { headers });
          if (!res.ok) return null;
          const thread = (await res.json()) as GmailThread;

          const messages = thread.messages ?? [];
          if (messages.length === 0) return null;

          const lastMsg = messages[messages.length - 1];
          const lastFrom =
            lastMsg.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
          const subject =
            lastMsg.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ??
            "(no subject)";
          const lastDate = lastMsg.internalDate ? Number(lastMsg.internalDate) : 0;
          if (lastDate === 0) return null;

          const hoursOld = (now - lastDate) / (60 * 60 * 1000);

          // Skip: Osman sent last (already replied), automated sender, too recent, or too old
          if (isOsman(lastFrom)) return null;
          if (isAutomated(lastFrom)) return null;
          if (now - lastDate < staleMs) return null;
          if (now - lastDate > lookbackDays * 24 * 60 * 60 * 1000) return null;

          return {
            threadId: id,
            subject,
            lastFrom,
            lastSnippet: lastMsg.snippet ?? "",
            lastMessageId: lastMsg.id,
            lastReceivedAt: new Date(lastDate).toISOString(),
            hoursSinceLastMessage: Math.round(hoursOld),
            accountEmail: account.email,
            accountLabel: account.label,
          } satisfies OpenThread;
        })
      );

      return threads
        .filter((r): r is PromiseFulfilledResult<OpenThread | null> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((t): t is OpenThread => t !== null);
    })
  );

  const all: OpenThread[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  // Most stale first — the ones most at risk of going cold
  return all.sort((a, b) => b.hoursSinceLastMessage - a.hoursSinceLastMessage);
}

/**
 * Fetches the full plain-text body for a single Gmail message.
 * Looks up the account matching `accountEmail` to get the right OAuth token.
 * Returns empty string on any failure (non-fatal — callers fall back to snippet).
 */
export async function fetchEmailBody(
  userId: string,
  accountEmail: string,
  emailId: string
): Promise<string> {
  const account = await prisma.googleAccount.findFirst({
    where: { userId, email: accountEmail },
    select: { id: true },
  });
  if (!account) return "";

  let token: string;
  try {
    token = await getValidToken(account.id);
  } catch {
    return "";
  }

  const res = await fetch(`${GMAIL_API}/messages/${emailId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return "";

  const msg = (await res.json()) as GmailFullMessage;
  const payload = msg.payload;
  if (!payload) return "";

  let body = "";
  if (payload.body?.data) {
    const raw = decodeBase64Url(payload.body.data);
    body = payload.mimeType === "text/html" ? stripHtml(raw) : raw;
  } else if (payload.parts) {
    body = extractBodyFromPart({ mimeType: payload.mimeType ?? "", parts: payload.parts });
  }

  return body.slice(0, 6000);
}
