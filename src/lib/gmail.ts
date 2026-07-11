import { prisma } from "./db";
import { getValidToken } from "./tokens";
import {
  googleStatusFromError,
  recordGoogleAccountHealth,
  recordGoogleAccountSkip,
  shortGoogleHealthError,
} from "./google-health";

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
  /** True when bulk-sender headers are present (List-Unsubscribe, Precedence: bulk/list, Auto-Submitted). */
  isBulk: boolean;
  /** Authentication-Results header, used only for scam demotion heuristics. */
  authenticationResults: string;
  accountEmail: string;
  accountLabel: string;
}

export type EmailCategory =
  | "action_needed"
  | "personal"
  | "newsletter"
  | "promotion"
  | "notification";

export interface AccountSyncResult {
  accountId: string;
  maskedEmail: string;
  label: string;
  status: "completed" | "failed" | "reauth_required";
  messagesScanned: number;
  messagesImported: number;
  lastSyncTime: string;
  errorRef?: string;
}

export interface InboxSyncSummary {
  messages: EmailMessage[];
  accounts: AccountSyncResult[];
}

export interface CorrespondentGraph {
  emails: Set<string>;
  total: number;
  lastRefreshedAt: string | null;
}

export interface ClassifyOptions {
  correspondents?: CorrespondentGraph | Set<string>;
}

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

const CORRESPONDENT_REFRESH_MS = 24 * 60 * 60 * 1000;
const SENT_SCAN_MAX_PER_ACCOUNT = 200;

function header(msg: GmailMessage, name: string): string {
  return (
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value ?? ""
  );
}

function extractEmailAddresses(value: string): string[] {
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function extractSenderEmail(from: string): string | null {
  return extractEmailAddresses(from)[0] ?? null;
}

/**
 * Detects bulk/automated mail from standard headers instead of a sender
 * allowlist, so new job boards and marketing senders demote themselves:
 * List-Unsubscribe (RFC 2369) is required of legitimate bulk senders,
 * Precedence: bulk/list/junk marks mailing-list traffic, and
 * Auto-Submitted (RFC 3834) marks machine-generated mail.
 */
function detectBulkHeaders(getHeader: (name: string) => string): boolean {
  if (getHeader("List-Unsubscribe")) return true;
  const precedence = getHeader("Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const autoSubmitted = getHeader("Auto-Submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  return false;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "****";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function accountResultStatus(status: ReturnType<typeof googleStatusFromError>): "failed" | "reauth_required" {
  return status === "expired" ? "reauth_required" : "failed";
}

/** Fetches metadata-only messages (no bodies) across all linked accounts. */
export async function fetchInboxMessages(
  userId: string,
  maxPerAccount = 15
): Promise<EmailMessage[]> {
  const { messages } = await syncGmailInbox(userId, maxPerAccount);
  return messages;
}

/**
 * Fetches inbox messages across all linked accounts with per-account sync status.
 * Surfaces token failures and network errors that were previously silently dropped.
 */
export async function syncGmailInbox(
  userId: string,
  maxPerAccount = 15
): Promise<InboxSyncSummary> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId },
    select: { id: true, email: true, label: true, scopes: true, refreshToken: true, expiresAt: true },
  });

  console.log(
    JSON.stringify({
      event: "gmail_accounts_discovered",
      userId,
      count: accounts.length,
      masked: accounts.map((a) => maskEmail(a.email)),
    })
  );

  if (accounts.length === 0) {
    console.log(
      JSON.stringify({ event: "gmail_sync_completed", userId, totalAccounts: 0, totalMessages: 0 })
    );
    return { messages: [], accounts: [] };
  }

  console.log(JSON.stringify({ event: "gmail_sync_started", userId, count: accounts.length }));

  const settled = await Promise.allSettled(
    accounts.map(
      async (account): Promise<{ messages: EmailMessage[]; result: AccountSyncResult }> => {
        const syncTime = new Date().toISOString();
        const masked = maskEmail(account.email);

        console.log(
          JSON.stringify({ event: "gmail_account_sync_started", accountId: account.id, masked })
        );

        try {
          if (!/gmail/i.test(account.scopes)) {
            await recordGoogleAccountSkip(account.id, "scope_missing", "Gmail scope missing");
            const result: AccountSyncResult = {
              accountId: account.id,
              maskedEmail: masked,
              label: account.label,
              status: "reauth_required",
              messagesScanned: 0,
              messagesImported: 0,
              lastSyncTime: syncTime,
              errorRef: "Gmail scope missing",
            };
            console.error(JSON.stringify({ event: "gmail_account_sync_skipped", ...result }));
            return { messages: [], result };
          }
          if (!account.refreshToken && account.expiresAt <= new Date()) {
            await recordGoogleAccountSkip(account.id, "expired", "Access token expired and no refresh token is available");
            const result: AccountSyncResult = {
              accountId: account.id,
              maskedEmail: masked,
              label: account.label,
              status: "reauth_required",
              messagesScanned: 0,
              messagesImported: 0,
              lastSyncTime: syncTime,
              errorRef: "Access token expired and no refresh token is available",
            };
            console.error(JSON.stringify({ event: "gmail_account_sync_skipped", ...result }));
            return { messages: [], result };
          }

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

          const fetched = await Promise.allSettled(
            ids.map(async ({ id }) => {
              const params = new URLSearchParams({ format: "metadata" });
              params.append("metadataHeaders", "Subject");
              params.append("metadataHeaders", "From");
              params.append("metadataHeaders", "List-Unsubscribe");
              params.append("metadataHeaders", "Precedence");
              params.append("metadataHeaders", "Auto-Submitted");
              params.append("metadataHeaders", "Authentication-Results");
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
                isBulk: detectBulkHeaders((name) => header(msg, name)),
                authenticationResults: header(msg, "Authentication-Results"),
                accountEmail: account.email,
                accountLabel: account.label,
              } satisfies EmailMessage;
            })
          );

          const messages = fetched
            .filter((r): r is PromiseFulfilledResult<EmailMessage> => r.status === "fulfilled")
            .map((r) => r.value);

          const result: AccountSyncResult = {
            accountId: account.id,
            maskedEmail: masked,
            label: account.label,
            status: "completed",
            messagesScanned: ids.length,
            messagesImported: messages.length,
            lastSyncTime: syncTime,
          };

          await recordGoogleAccountHealth(account.id, "ok", null, new Date(syncTime)).catch(() => undefined);
          console.log(JSON.stringify({ event: "gmail_account_sync_completed", ...result }));
          return { messages, result };
        } catch (err) {
          const errorRef = (err instanceof Error ? err.message : String(err)).slice(0, 200);
          const healthStatus = googleStatusFromError(err);
          const status = accountResultStatus(healthStatus);
          await recordGoogleAccountHealth(account.id, healthStatus, shortGoogleHealthError(err)).catch(() => undefined);
          const result: AccountSyncResult = {
            accountId: account.id,
            maskedEmail: masked,
            label: account.label,
            status,
            messagesScanned: 0,
            messagesImported: 0,
            lastSyncTime: syncTime,
            errorRef,
          };
          console.error(JSON.stringify({ event: "gmail_account_sync_failed", ...result }));
          return { messages: [], result };
        }
      }
    )
  );

  const allMessages: EmailMessage[] = [];
  const accountResults: AccountSyncResult[] = [];

  for (const r of settled) {
    if (r.status === "fulfilled") {
      allMessages.push(...r.value.messages);
      accountResults.push(r.value.result);
    } else {
      // fetchAccountMessages catches internally — this branch covers unexpected rejections
      console.error(
        JSON.stringify({
          event: "gmail_account_sync_failed",
          reason: String(r.reason).slice(0, 200),
        })
      );
    }
  }

  const completedCount = accountResults.filter((a) => a.status === "completed").length;
  const failedCount = accountResults.filter((a) => a.status !== "completed").length;

  console.log(
    JSON.stringify({
      event: "gmail_sync_completed",
      userId,
      totalAccounts: accounts.length,
      completedAccounts: completedCount,
      failedAccounts: failedCount,
      totalMessages: allMessages.length,
    })
  );

  return {
    messages: allMessages.sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    ),
    accounts: accountResults,
  };
}

type CorrespondentAccumulator = {
  displayName: string | null;
  sentCount: number;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
};

function newestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function oldestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function displayNameFromHeader(value: string): string | null {
  const withoutAddress = value.replace(/<[^>]+>/g, "").trim().replace(/^"|"$/g, "");
  return withoutAddress || null;
}

async function latestCorrespondentRefresh(userId: string): Promise<Date | null> {
  const [row, run] = await Promise.all([
    prisma.emailCorrespondent.findFirst({
      where: { userId },
      orderBy: { lastScannedAt: "desc" },
      select: { lastScannedAt: true },
    }).catch(() => null),
    prisma.agentRun.findFirst({
      where: { agentName: "email-correspondent-graph", inputSummary: `correspondent_graph_refresh user=${userId}` },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }).catch(() => null),
  ]);
  return newestDate(row?.lastScannedAt ?? null, run?.createdAt ?? null);
}

export async function refreshCorrespondentGraph(userId: string): Promise<{ scannedAccounts: number; correspondents: number; refreshedAt: string }> {
  const accounts = await prisma.googleAccount.findMany({
    where: { userId, scopes: { contains: "gmail" } },
    select: { id: true, email: true },
  });
  const accountEmails = new Set(accounts.map((account) => account.email.toLowerCase()));
  const refreshedAt = new Date();
  let scannedAccounts = 0;
  let correspondents = 0;

  for (const account of accounts) {
    const byEmail = new Map<string, CorrespondentAccumulator>();
    try {
      const token = await getValidToken(account.id);
      const headers = { Authorization: `Bearer ${token}` };
      const listParams = new URLSearchParams({
        maxResults: String(SENT_SCAN_MAX_PER_ACCOUNT),
        labelIds: "SENT",
      });
      const listRes = await fetch(`${GMAIL_API}/messages?${listParams}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!listRes.ok) throw new Error(`Gmail sent list ${listRes.status} for ${maskEmail(account.email)}`);
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      const ids = list.messages ?? [];

      const fetched = await Promise.allSettled(
        ids.map(async ({ id }) => {
          const params = new URLSearchParams({ format: "metadata" });
          params.append("metadataHeaders", "To");
          params.append("metadataHeaders", "Cc");
          params.append("metadataHeaders", "Bcc");
          params.append("metadataHeaders", "Date");
          const res = await fetch(`${GMAIL_API}/messages/${id}?${params}`, { headers, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`Gmail sent get ${res.status} for ${id}`);
          return (await res.json()) as GmailMessage;
        })
      );

      for (const result of fetched) {
        if (result.status !== "fulfilled") continue;
        const msg = result.value;
        const sentAt = msg.internalDate ? new Date(Number(msg.internalDate)) : (header(msg, "Date") ? new Date(header(msg, "Date")) : null);
        const recipientsHeader = [header(msg, "To"), header(msg, "Cc"), header(msg, "Bcc")].filter(Boolean).join(", ");
        const recipients = extractEmailAddresses(recipientsHeader).filter((email) => !accountEmails.has(email));
        for (const email of recipients) {
          const existing = byEmail.get(email);
          byEmail.set(email, {
            displayName: existing?.displayName ?? displayNameFromHeader(recipientsHeader),
            sentCount: (existing?.sentCount ?? 0) + 1,
            firstSentAt: oldestDate(existing?.firstSentAt ?? null, sentAt),
            lastSentAt: newestDate(existing?.lastSentAt ?? null, sentAt),
          });
        }
      }

      for (const [email, data] of byEmail) {
        await prisma.emailCorrespondent.upsert({
          where: { userId_accountEmail_email: { userId, accountEmail: account.email, email } },
          create: {
            userId,
            accountEmail: account.email,
            email,
            displayName: data.displayName,
            sentCount: data.sentCount,
            firstSentAt: data.firstSentAt,
            lastSentAt: data.lastSentAt,
            lastScannedAt: refreshedAt,
          },
          update: {
            displayName: data.displayName,
            sentCount: data.sentCount,
            firstSentAt: data.firstSentAt,
            lastSentAt: data.lastSentAt,
            lastScannedAt: refreshedAt,
          },
        });
      }

      scannedAccounts += 1;
      correspondents += byEmail.size;
    } catch (error) {
      console.error(JSON.stringify({
        event: "email_correspondent_graph_account_failed",
        account: maskEmail(account.email),
        error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
      }));
    }
  }

  await prisma.agentRun.create({
    data: {
      agentName: "email-correspondent-graph",
      inputSummary: `correspondent_graph_refresh user=${userId}`,
      outputSummary: `Scanned ${scannedAccounts}/${accounts.length} Gmail account(s); cached ${correspondents} correspondent address(es).`,
      modelProvider: "internal",
      status: scannedAccounts > 0 || accounts.length === 0 ? "completed" : "failed",
    },
  }).catch(() => undefined);

  return { scannedAccounts, correspondents, refreshedAt: refreshedAt.toISOString() };
}

export async function getCorrespondentGraph(userId: string, options: { forceRefresh?: boolean } = {}): Promise<CorrespondentGraph> {
  const latest = await latestCorrespondentRefresh(userId);
  const stale = !latest || Date.now() - latest.getTime() > CORRESPONDENT_REFRESH_MS;
  if (options.forceRefresh || stale) {
    await refreshCorrespondentGraph(userId);
  }

  const rows = await prisma.emailCorrespondent.findMany({
    where: { userId },
    select: { email: true, lastScannedAt: true },
  }).catch(() => []);
  const emails = new Set(rows.map((row) => row.email.toLowerCase()));
  const lastRefreshedAt = rows.reduce<Date | null>((latestDate, row) => newestDate(latestDate, row.lastScannedAt), null);
  return { emails, total: emails.size, lastRefreshedAt: lastRefreshedAt?.toISOString() ?? latest?.toISOString() ?? null };
}

const NEWSLETTER_HINTS = ["unsubscribe", "newsletter", "digest"];
// Automated-sender address patterns. Demote-only: a match moves mail out of
// action_needed, never into it, so a false positive just files noise lower.
const NOTIFICATION_SENDERS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "do_not_reply",
  "notifications@",
  "notification@",
  "mailer-daemon",
  "postmaster@",
  "alerts@",
  "alert@",
  "notify@",
  "updates@",
  "marketing@",
  "newsletter@",
];

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

const FINANCIAL_SCAM_HINTS = [
  "loan",
  "credit",
  "pre-approved",
  "pre approved",
  "wire transfer",
  "urgent transfer",
  "cash advance",
  "debt relief",
  "funding offer",
  "funding",
  "funds",
  "business funding",
  "personal funding",
  "approval in",
];

function hasAuthenticationFailure(authenticationResults?: string): boolean {
  const value = authenticationResults?.toLowerCase() ?? "";
  if (!value) return false;
  return /\b(spf|dkim|dmarc)=(?:fail|softfail|permerror|temperror|neutral|none)\b/.test(value)
    || /\bdoes not designate permitted sender\b/.test(value)
    || /\bauthentication.*fail/.test(value);
}

function hasFinancialScamLanguage(subject: string, snippet: string): boolean {
  const text = `${subject} ${snippet}`;
  return FINANCIAL_SCAM_HINTS.some((hint) => text.includes(hint));
}

function correspondentSet(input: ClassifyOptions["correspondents"]): Set<string> | null {
  if (!input) return null;
  return input instanceof Set ? input : input.emails;
}

/** Heuristic, metadata-only classification — no LLM call needed for Lean Mode. */
export function classify(message: EmailMessage, options: ClassifyOptions = {}): EmailCategory {
  const labels = message.labels;
  const from = message.from.toLowerCase();
  const subject = message.subject.toLowerCase();
  const snippet = message.snippet.toLowerCase();
  const senderEmail = extractSenderEmail(message.from);
  const correspondents = correspondentSet(options.correspondents);
  const hasCorresponded = Boolean(senderEmail && correspondents?.has(senderEmail));

  // Demote known marketing / job-spam senders before any action_needed path.
  if (LOW_PRIORITY_SENDER_DOMAINS.some((d) => from.includes(d))) {
    return "promotion";
  }
  if (LOW_PRIORITY_SUBJECT_HINTS.some((h) => subject.includes(h))) {
    return "notification";
  }
  if (hasAuthenticationFailure(message.authenticationResults) && hasFinancialScamLanguage(subject, snippet)) {
    return "promotion";
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
  if (message.isUnread && correspondents && senderEmail && !hasCorresponded && isLikelyOneWayServiceSender(from)) {
    return "notification";
  }
  // Bulk-sender headers catch automated senders the category labels and sender
  // lists above missed — new job boards and marketing blasts demote here
  // without anyone maintaining an allowlist.
  if (message.isBulk) {
    return "newsletter";
  }
  // action_needed requires positive evidence of a real correspondent: Gmail
  // importance, the personal category, an actual sent-mail relationship, or
  // (by elimination above) a non-bulk, non-automated From address. Unread mail
  // with no such evidence files as a notification instead of flooding priority.
  if (message.isUnread) {
    return hasCorresponded || message.isImportant || labels.includes("CATEGORY_PERSONAL") || isLikelyHumanSender(from)
      ? "action_needed"
      : "notification";
  }
  return "personal";
}

// Common ESP/bounce subdomains and automated locals that survive the earlier
// checks. Demote-only, same rule as NOTIFICATION_SENDERS.
const AUTOMATED_FROM_HINTS = [
  "@e.",
  "@em.",
  "@mail.",
  "@email.",
  "@mailer.",
  "@bounce",
  "@news.",
  "@marketing.",
  "@mktg.",
  "info@",
  "hello@",
  "team@",
];

const SERVICE_NOTIFICATION_HINTS = [
  "workday",
  "myworkday",
  "service-now",
  "servicenow",
  "salesforce",
  "okta",
  "docusign",
];

function isLikelyHumanSender(from: string): boolean {
  return !AUTOMATED_FROM_HINTS.some((h) => from.includes(h));
}

function isLikelyOneWayServiceSender(from: string): boolean {
  return AUTOMATED_FROM_HINTS.some((h) => from.includes(h))
    || SERVICE_NOTIFICATION_HINTS.some((h) => from.includes(h));
}

export interface TriageResult {
  total: number;
  unread: number;
  byCategory: Record<EmailCategory, EmailMessage[]>;
  needsAttention: EmailMessage[];
}

/** Groups inbox messages by category and surfaces what needs attention first. */
export async function triage(userId: string, maxPerAccount = 15): Promise<TriageResult> {
  const [messages, correspondents] = await Promise.all([
    fetchInboxMessages(userId, maxPerAccount),
    getCorrespondentGraph(userId),
  ]);

  const byCategory: Record<EmailCategory, EmailMessage[]> = {
    action_needed: [],
    personal: [],
    newsletter: [],
    promotion: [],
    notification: [],
  };

  for (const message of messages) {
    byCategory[classify(message, { correspondents })].push(message);
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
            isBulk: detectBulkHeaders(getHeader),
            authenticationResults: getHeader("Authentication-Results"),
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
  // No CATEGORY_PROMOTIONS exclusion here: Gmail routinely auto-labels
  // LinkedIn/Indeed/ZipRecruiter job alerts as Promotions, and this query is
  // already restricted to the trusted JOB_ALERT_SENDERS allowlist, so the
  // exclusion only dropped the exact emails this pipeline exists to catch.
  const query = `(${senderQuery}) newer_than:1d`;

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
            isBulk: detectBulkHeaders(getHeader),
            authenticationResults: getHeader("Authentication-Results"),
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
