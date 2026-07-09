import { prisma } from "@/lib/db";
import { getValidToken } from "@/lib/tokens";
import { classify, getCorrespondentGraph, type EmailMessage } from "@/lib/gmail";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const WORKDAY_QUERIES = [
  "in:inbox newer_than:365d workday",
  "in:inbox newer_than:365d myworkday",
  "in:inbox newer_than:365d from:workday",
  "in:inbox newer_than:365d from:myworkday",
  "in:inbox newer_than:365d from:notifications@myworkday.com",
];

type GmailHeader = { name: string; value: string };
type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};

function maskAddress(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "****";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractSenderEmail(from: string): string | null {
  return from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? null;
}

function detectBulkHeaders(getHeader: (name: string) => string): boolean {
  if (getHeader("List-Unsubscribe")) return true;
  const precedence = getHeader("Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;
  const autoSubmitted = getHeader("Auto-Submitted").toLowerCase();
  return Boolean(autoSubmitted && autoSubmitted !== "no");
}

async function fetchWorkdayMessages(account: { id: string; email: string; label: string }): Promise<EmailMessage[]> {
  const token = await getValidToken(account.id);
  const headers = { Authorization: `Bearer ${token}` };
  const ids = new Set<string>();
  for (const query of WORKDAY_QUERIES) {
    const params = new URLSearchParams({ maxResults: "10", q: query });
    const res = await fetch(`${GMAIL_API}/messages?${params}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gmail Workday search returned HTTP ${res.status} for ${maskAddress(account.email)}`);
    const list = (await res.json()) as { messages?: { id: string }[] };
    for (const message of list.messages ?? []) ids.add(message.id);
  }

  const messages: EmailMessage[] = [];
  for (const id of [...ids].slice(0, 12)) {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of ["Subject", "From", "List-Unsubscribe", "Precedence", "Auto-Submitted", "Authentication-Results"]) {
      params.append("metadataHeaders", name);
    }
    const res = await fetch(`${GMAIL_API}/messages/${id}?${params}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const msg = (await res.json()) as GmailMessage;
    const labels = msg.labelIds ?? [];
    messages.push({
      id: msg.id,
      threadId: msg.threadId,
      subject: header(msg, "Subject") || "(no subject)",
      from: header(msg, "From"),
      snippet: msg.snippet ?? "",
      receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
      labels,
      isUnread: labels.includes("UNREAD"),
      isImportant: labels.includes("IMPORTANT"),
      isBulk: detectBulkHeaders((name) => header(msg, name)),
      authenticationResults: header(msg, "Authentication-Results"),
      accountEmail: account.email,
      accountLabel: account.label,
    });
  }
  return messages;
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      primaryEmail: true,
      accounts: {
        where: { scopes: { contains: "gmail" } },
        select: { id: true, email: true, label: true },
      },
    },
  });

  const results = [];
  for (const user of users) {
    if (!user.accounts.length) continue;
    const correspondents = await getCorrespondentGraph(user.id, { forceRefresh: true });
    for (const account of user.accounts) {
      const messages = await fetchWorkdayMessages(account);
      for (const message of messages) {
        const senderEmail = extractSenderEmail(message.from);
        results.push({
          user: maskAddress(user.primaryEmail),
          account: maskAddress(account.email),
          accountLabel: account.label,
          id: message.id,
          receivedAt: message.receivedAt,
          from: message.from,
          senderEmail,
          senderInCorrespondentGraph: senderEmail ? correspondents.emails.has(senderEmail) : false,
          subject: message.subject,
          snippet: message.snippet,
          labels: message.labels,
          isUnread: message.isUnread,
          isImportant: message.isImportant,
          isBulk: message.isBulk,
          classification: classify(message, { correspondents }),
        });
      }
    }
  }

  return Response.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    resultCount: results.length,
    actionNeededCount: results.filter((row) => row.classification === "action_needed").length,
    notificationCount: results.filter((row) => row.classification === "notification").length,
    results,
  });
}
