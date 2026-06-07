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

/** Heuristic, metadata-only classification — no LLM call needed for Lean Mode. */
export function classify(message: EmailMessage): EmailCategory {
  const labels = message.labels;
  const from = message.from.toLowerCase();
  const subject = message.subject.toLowerCase();
  const snippet = message.snippet.toLowerCase();

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
  return prisma.approvalAction.create({
    data: {
      userId,
      actionType: "draft_email",
      status: "pending",
      payload: JSON.stringify(params),
    },
  });
}
