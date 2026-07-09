// Vercel Cron: inbox-digest (Section 5.2 — three-inbox scanning + reply drafting).
// Full triage across every linked Google account through the fixed classifier,
// summarized as one Telegram digest per user:
//
//   - per-account counts (total / unread / action-needed) + reconnect warnings
//   - recent action-needed emails routed through the existing agent handoffs
//     (Themis for I-9/compliance, Athena for recruiter/job mail) so drafts land
//     in the ApprovalAction queue — nothing sends automatically
//
// Also callable on demand with the same CRON_SECRET bearer. Scheduling lives in
// vercel.json and MUST stay daily-or-slower (Vercel Hobby rejects sub-daily
// crons at deploy time); the local worker's email-watcher poll covers the
// minute-level alerting between digests.

import { prisma } from "@/lib/db";
import { syncGmailInbox, fetchEmailBody, classify, getCorrespondentGraph, type EmailMessage, type EmailCategory } from "@/lib/gmail";
import { classifyEmailRoute, routeToThemis, routeToAthena } from "@/lib/agentHandoff";
import { sendTelegramMessage } from "@/lib/telegram";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const RECENT_MS = 24 * 60 * 60 * 1000; // draft replies only for mail from the last 24h
const MAX_DRAFTS_PER_RUN = 3; // keep the run well inside the 60s function budget
const MAX_LISTED_PER_DIGEST = 8;

type PerAccount = {
  email: string;
  label: string;
  total: number;
  unread: number;
  byCategory: Record<EmailCategory, number>;
};

function emptyCounts(): Record<EmailCategory, number> {
  return { action_needed: 0, personal: 0, newsletter: 0, promotion: 0, notification: 0 };
}

function fromDisplay(from: string): string {
  return from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : from;
}

function maskAddress(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "****";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true, primaryEmail: true } });
  const now = Date.now();
  const summaries: Array<{ user: string; accounts: number; actionNeeded: number; drafts: number }> = [];

  for (const user of users) {
    const [sync, correspondents] = await Promise.all([
      syncGmailInbox(user.id, 20).catch(() => null),
      getCorrespondentGraph(user.id).catch(() => null),
    ]);
    if (!sync || sync.accounts.length === 0) continue;

    // Tallies keyed by raw account address; sync.accounts (masked) is used
    // only for the reconnect warnings further down.
    const perAccount = new Map<string, PerAccount>();
    const actionNeeded: EmailMessage[] = [];
    for (const message of sync.messages) {
      const category = classify(message, { correspondents: correspondents ?? undefined });
      if (category === "action_needed") actionNeeded.push(message);
      let row = perAccount.get(message.accountEmail);
      if (!row) {
        row = { email: message.accountEmail, label: message.accountLabel, total: 0, unread: 0, byCategory: emptyCounts() };
        perAccount.set(message.accountEmail, row);
      }
      row.total += 1;
      if (message.isUnread) row.unread += 1;
      row.byCategory[category] += 1;
    }

    // Draft replies for recent action-needed mail via the existing handoffs.
    // Dedup against email-watcher and previous digests through the same
    // AgentRun email=<id> convention.
    const recentAction = actionNeeded
      .filter((m) => now - new Date(m.receivedAt).getTime() < RECENT_MS)
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

    const draftNotes: string[] = [];
    for (const email of recentAction) {
      if (draftNotes.length >= MAX_DRAFTS_PER_RUN) break;
      const alreadyHandled = await prisma.agentRun.findFirst({
        where: { inputSummary: { contains: email.id }, createdAt: { gte: new Date(now - RECENT_MS) } },
      });
      if (alreadyHandled) continue;

      const body = await fetchEmailBody(user.id, email.accountEmail, email.id).catch(() => "");
      const route = classifyEmailRoute(email.subject, email.snippet, email.from, body);
      try {
        if (route === "i9_compliance") {
          const result = await routeToThemis(user.id, { ...email, body: body || undefined });
          draftNotes.push(`Themis drafted a grounded reply to "${email.subject.slice(0, 60)}" (approval ${result.action.id.slice(0, 8)})`);
        } else if (route === "recruiter" || route === "job_application") {
          const result = await routeToAthena(user.id, { ...email, body: body || undefined });
          draftNotes.push(`Athena drafted a reply to "${email.subject.slice(0, 60)}" (approval ${result.action.id.slice(0, 8)})`);
        } else {
          continue; // general action mail is listed in the digest but not auto-drafted
        }
        await prisma.agentRun.create({
          data: {
            agentName: "iris",
            inputSummary: `inbox-digest draft email=${email.id} route=${route}`,
            outputSummary: draftNotes[draftNotes.length - 1],
            status: "completed",
          },
        });
      } catch (err) {
        console.error(`[inbox-digest] handoff failed for "${email.subject}":`, err);
      }
    }

    // Build the digest message (sendTelegramMessage defaults to plain text)
    const lines = [`📥 Inbox digest (${perAccount.size} account${perAccount.size !== 1 ? "s" : ""})`];
    for (const row of perAccount.values()) {
      const tag = row.label ? `${row.label} (${maskAddress(row.email)})` : maskAddress(row.email);
      lines.push(`\n${tag} — ${row.total} scanned, ${row.unread} unread, ${row.byCategory.action_needed} action-needed`);
    }
    const reauth = sync.accounts.filter((a) => a.status === "reauth_required");
    for (const account of reauth) {
      lines.push(`\n⚠️ ${account.label || account.maskedEmail} needs reconnecting — open Health Center.`);
    }
    if (actionNeeded.length) {
      lines.push(`\nAction needed (${actionNeeded.length}):`);
      for (const email of actionNeeded.slice(0, MAX_LISTED_PER_DIGEST)) {
        lines.push(`• ${fromDisplay(email.from)} — ${email.subject.slice(0, 70)}`);
      }
      if (actionNeeded.length > MAX_LISTED_PER_DIGEST) lines.push(`…and ${actionNeeded.length - MAX_LISTED_PER_DIGEST} more.`);
    } else {
      lines.push(`\nNothing needs a reply right now.`);
    }
    if (draftNotes.length) {
      lines.push(`\nDrafts waiting for your approval:`);
      for (const note of draftNotes) lines.push(`• ${note}`);
    }

    if (OWNER_CHAT_ID) {
      await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n")).catch((err) =>
        console.error("[inbox-digest] Telegram send failed:", err)
      );
    }

    await prisma.agentRun.create({
      data: {
        agentName: "iris",
        inputSummary: "inbox-digest",
        outputSummary: `Digest across ${perAccount.size} account(s): ${sync.messages.length} scanned, ${actionNeeded.length} action-needed, ${draftNotes.length} draft(s) queued${reauth.length ? `, ${reauth.length} account(s) need reconnect` : ""}.`,
        status: "completed",
      },
    });

    summaries.push({ user: user.primaryEmail, accounts: perAccount.size, actionNeeded: actionNeeded.length, drafts: draftNotes.length });
  }

  return Response.json({ ok: true, job: "inbox-digest", summaries });
}
