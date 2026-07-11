// Vercel Cron: email-watcher.
// Fetches recent action-needed emails, fetches their full bodies, routes each
// to the right downstream agent, and sends a Telegram notification:
//
//   I-9 / workplace email  →  Themis  →  draft_email ApprovalAction (M-274 grounded)
//   Recruiter / job email  →  Athena  →  tracker update + draft_email ApprovalAction
//   Other action emails    →  Telegram notification only (no agent draft)
//
// Nothing sends automatically. Every agent-generated draft lands in the approval
// queue for Osman to review and copy-paste to Gmail himself.

import { prisma } from "@/lib/db";
import { classify, fetchInboxMessages, fetchEmailBody, getCorrespondentGraph } from "@/lib/gmail";
import { sendTelegramMessage } from "@/lib/telegram";
import { classifyEmailRoute, routeActionEmailFollowUp, routeToThemis, routeToAthena } from "@/lib/agentHandoff";
import type { InlineButton } from "@/lib/telegram";
import { recordGoogleAccountSkip } from "@/lib/google-health";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // don't re-notify same email for 4 hours
const RECENCY_MS = 20 * 60 * 1000; // only alert on emails received in the last 20 min

const ACTION_KEYWORDS = [
  "still interested", "are you available", "interview", "next steps",
  "offer", "deadline", "action required", "please respond", "following up",
  "follow up", "recruiter", "opportunity", "application", "schedule",
  "availability", "onsite", "on-site", "virtual", "zoom", "teams meeting",
  "background check", "start date", "onboarding", "rejection", "unfortunately",
  "move forward", "next round", "phone screen", "technical",
  "i-9", "i9", "employment eligibility", "uscis", "e-verify",
  "work authorization", "reverification",
];

function isActionNeeded(subject: string, snippet: string, from: string): boolean {
  const text = `${subject} ${snippet} ${from}`.toLowerCase();
  return ACTION_KEYWORDS.some((kw) => text.includes(kw));
}

const ROUTE_LABEL: Record<string, string> = {
  i9_compliance: "I-9 / Compliance",
  recruiter: "Recruiter",
  job_application: "Job Application",
  general: "Action needed",
};

const AGENT_LABEL: Record<string, string> = {
  i9_compliance: "Themis is drafting a grounded reply",
  recruiter: "Athena is drafting a reply + updating your tracker",
  job_application: "Athena is updating your job tracker",
};

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!OWNER_CHAT_ID) {
    return Response.json({ ok: false, reason: "TELEGRAM_OWNER_CHAT_ID not set" });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const now = new Date();
  const notified: string[] = [];
  let disconnectedUsers = 0;

  for (const user of users) {
    // Usable = refresh token present OR access token still live — the access
    // token rotating hourly is normal OAuth, not a disconnected account.
    const gmailAccounts = await prisma.googleAccount.findMany({
      where: {
        userId: user.id,
        scopes: { contains: "gmail" },
      },
      select: { id: true, refreshToken: true, expiresAt: true },
    });
    const usableAccounts = gmailAccounts.filter((account) => account.refreshToken || account.expiresAt > now);
    const expiredAccounts = gmailAccounts.filter((account) => !account.refreshToken && account.expiresAt <= now);
    await Promise.all(
      expiredAccounts.map((account) =>
        recordGoogleAccountSkip(account.id, "expired", "Email watcher skipped account: token expired and no refresh token is available").catch(() => undefined)
      )
    );
    if (usableAccounts.length === 0) {
      disconnectedUsers += 1;
      const outputSummary = gmailAccounts.length === 0
        ? "Email Scout did not run: no connected Google account with Gmail scope. Reconnect Google from Health Center."
        : "Email Scout did not run: connected Gmail accounts are expired. Reconnect Google from Health Center.";
      await prisma.agentRun.create({
        data: {
          agentName: "email-watcher",
          inputSummary: gmailAccounts.length === 0 ? "gmail_disconnected" : "gmail_expired",
          outputSummary,
          status: "failed",
        },
      });
      continue;
    }

    let emails;
    let correspondents;
    try {
      [emails, correspondents] = await Promise.all([
        fetchInboxMessages(user.id, 20),
        getCorrespondentGraph(user.id),
      ]);
    } catch {
      continue;
    }

    // Filter to recent + action-needed emails
    const actionEmails = emails.filter((m) => {
      const receivedAt = new Date(m.receivedAt);
      const isRecent = now.getTime() - receivedAt.getTime() < RECENCY_MS;
      return isRecent && classify(m, { correspondents }) === "action_needed" && isActionNeeded(m.subject, m.snippet, m.from);
    });

    for (const email of actionEmails) {
      // Dedup — skip if already notified for this email in the last 4 hours
      const alreadySent = await prisma.agentRun.findFirst({
        where: {
          agentName: "email-watcher",
          inputSummary: { contains: email.id },
          createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
        },
      });
      if (alreadySent) continue;

      // Fetch full body for agent routing (falls back to snippet on failure)
      const body = await fetchEmailBody(user.id, email.accountEmail, email.id).catch(() => "");
      const route = classifyEmailRoute(email.subject, email.snippet, email.from, body);

      // Route to the right agent and generate a draft if applicable
      let agentNote = "";
      let draftActionId: string | undefined;
      let followUpActionId: string | undefined;

      if (route === "i9_compliance") {
        try {
          const result = await routeToThemis(user.id, { ...email, body: body || undefined });
          draftActionId = result.action.id;
          agentNote = `\nThemis has drafted a grounded reply (approval ID: ${result.action.id.slice(0, 8)}).`;
        } catch (err) {
          console.error(`[email-watcher] Themis handoff failed for "${email.subject}":`, err);
          agentNote = "\nThemis handoff failed — see logs.";
        }
      } else if (route === "recruiter" || route === "job_application") {
        try {
          const result = await routeToAthena(user.id, { ...email, body: body || undefined });
          draftActionId = result.action.id;
          const trackerNote = result.isNewApp ? "New application logged." : "Tracker updated.";
          agentNote = `\nAthena drafted a reply. ${trackerNote} (approval ID: ${result.action.id.slice(0, 8)}).`;
        } catch (err) {
          console.error(`[email-watcher] Athena handoff failed for "${email.subject}":`, err);
          agentNote = "\nAthena handoff failed — see logs.";
        }
      }

      try {
        const followUp = await routeActionEmailFollowUp(user.id, { ...email, body: body || undefined });
        if (followUp.action) {
          followUpActionId = followUp.action.id;
          const noun = followUp.classification.kind === "event" ? "calendar event" : "task";
          agentNote += `\nIris drafted a ${noun} for approval (approval ID: ${followUp.action.id.slice(0, 8)}).`;
        }
      } catch (err) {
        console.error(`[email-watcher] follow-up handoff failed for "${email.subject}":`, err);
        agentNote += "\nFollow-up draft failed — see logs.";
      }

      // Clean up sender display name
      const fromDisplay = email.from.includes("<")
        ? email.from.split("<")[0].trim().replace(/^"|"$/g, "")
        : email.from;

      const routeLabel = ROUTE_LABEL[route] ?? "Action needed";
      const agentAction = AGENT_LABEL[route];

      const lines = [
        `📬 *${routeLabel}*`,
        `*From:* ${fromDisplay}`,
        `*Subject:* ${email.subject}`,
        `*Preview:* ${email.snippet.slice(0, 120)}${email.snippet.length > 120 ? "…" : ""}`,
        agentAction ? `\n${agentAction}.` : "",
        agentNote,
      ].filter(Boolean);

      const draftCommand = `draft a reply to this email from ${fromDisplay} about: ${email.subject}`;
      const buttons: InlineButton[][] = [
        [
          draftActionId
            ? { text: "✅ Review Draft", callback_data: `approve ${draftActionId}`.slice(0, 64) }
            : followUpActionId
              ? { text: "✅ Review Follow-up", callback_data: `approve ${followUpActionId}`.slice(0, 64) }
            : { text: "✏️ Draft Reply", callback_data: draftCommand.slice(0, 64) },
          { text: "👁 Mark Read", callback_data: `mark as read: ${email.subject.slice(0, 30)}` },
        ],
      ];

      try {
        await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n"), buttons);
        await prisma.agentRun.create({
          data: {
            agentName: "email-watcher",
            inputSummary: `email=${email.id} route=${route} from=${email.from.slice(0, 60)}`,
            outputSummary: `notified: ${email.subject.slice(0, 100)}${draftActionId ? ` | draft=${draftActionId.slice(0, 8)}` : ""}${followUpActionId ? ` | followup=${followUpActionId.slice(0, 8)}` : ""}`,
            status: "completed",
          },
        });
        notified.push(`${routeLabel}: ${email.subject}`);
      } catch (err) {
        console.error(`[email-watcher] Telegram send failed for "${email.subject}":`, err);
      }
    }
  }

  if (users.length > 0 && disconnectedUsers === users.length) {
    return Response.json(
      { ok: false, job: "email-watcher", reason: "No connected Google account with Gmail scope. Reconnect Google from Health Center." },
      { status: 503 }
    );
  }

  return Response.json({ ok: true, job: "email-watcher", notified });
}
