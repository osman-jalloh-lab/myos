// Vercel Cron + local-worker endpoint: email-watcher.
//
// This is intentionally usable from two schedules:
// - Vercel Cron performs a daily broad sweep so an offline local worker does not
//   create a full-day blind spot.
// - The always-on local worker calls ?mode=fast every few minutes for timely mail.
//
// Confirmed interviews with an explicit date/time can be added to Calendar only
// when AUTO_SCHEDULE_CONFIRMED_INTERVIEWS=true. Availability requests still go
// through Athena's draft-reply path. Nothing ever sends an email automatically.
import { prisma } from "@/lib/db";
import { fetchInboxMessages, fetchEmailBody } from "@/lib/gmail";
import { sendTelegramMessage } from "@/lib/telegram";
import { classifyEmailRoute, routeToThemis, routeToAthena } from "@/lib/agentHandoff";
import {
  formatInterviewDateTime,
  processInterviewEmail,
  type InterviewAutomationResult,
} from "@/lib/interviewScheduler";
import type { InlineButton } from "@/lib/telegram";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const FAST_RECENCY_MS = 35 * 60 * 1000;
const BROAD_RECENCY_MS = 26 * 60 * 60 * 1000;
const FAST_MAX_PER_ACCOUNT = 25;
const BROAD_MAX_PER_ACCOUNT = 100;

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
  recruiter: "Athena is reviewing the career email",
  job_application: "Athena is updating your job tracker",
};

function calendarLines(result: InterviewAutomationResult | null): string[] {
  if (!result?.scheduled || !result.event || !result.analysis.start) return [];
  const lines = [
    `📅 Calendar: ${result.created ? "added" : "already had"} ${result.event.summary}`,
    `When: ${formatInterviewDateTime(result.analysis.start)}`,
  ];
  if (result.conflicts.length > 0) {
    lines.push(`⚠️ Conflict check: overlaps ${result.conflicts.map((c) => c.summary).join(", ")}.`);
  }
  if (result.prepTaskCreated) lines.push("Created a high-priority interview prep task.");
  return lines;
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const mode = new URL(req.url).searchParams.get("mode");
  const fastMode = mode === "fast";
  const recencyMs = fastMode ? FAST_RECENCY_MS : BROAD_RECENCY_MS;
  const maxPerAccount = fastMode ? FAST_MAX_PER_ACCOUNT : BROAD_MAX_PER_ACCOUNT;

  const users = await prisma.user.findMany({ select: { id: true } });
  const now = new Date();
  const processed: string[] = [];
  let disconnectedUsers = 0;

  for (const user of users) {
    const gmailAccountCount = await prisma.googleAccount.count({
      where: { userId: user.id, scopes: { contains: "gmail" }, expiresAt: { gt: now } },
    });
    if (gmailAccountCount === 0) {
      disconnectedUsers += 1;
      await prisma.agentRun.create({
        data: {
          agentName: "email-watcher",
          inputSummary: "gmail_disconnected",
          outputSummary: "Email Scout did not run: no connected Google account with Gmail scope. Reconnect Google from Health Center.",
          status: "failed",
        },
      });
      continue;
    }

    let emails;
    try {
      emails = await fetchInboxMessages(user.id, maxPerAccount);
    } catch {
      continue;
    }

    const actionEmails = emails.filter((m) => {
      const receivedAt = new Date(m.receivedAt);
      const isRecent = now.getTime() - receivedAt.getTime() < recencyMs;
      return isRecent && isActionNeeded(m.subject, m.snippet, m.from);
    });

    for (const email of actionEmails) {
      const alreadyProcessed = await prisma.agentRun.findFirst({
        where: {
          agentName: "email-watcher",
          inputSummary: { contains: `email=${email.id}` },
          createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
        },
      });
      if (alreadyProcessed) continue;

      const body = await fetchEmailBody(user.id, email.accountEmail, email.id).catch(() => "");
      const route = classifyEmailRoute(email.subject, email.snippet, email.from, body);
      let interview: InterviewAutomationResult | null = null;
      let agentNote = "";
      let draftActionId: string | undefined;

      if (route === "recruiter" || route === "job_application") {
        try {
          interview = await processInterviewEmail(user.id, {
            id: email.id,
            threadId: email.threadId,
            from: email.from,
            subject: email.subject,
            snippet: email.snippet,
            body,
            receivedAt: email.receivedAt,
          });
        } catch (err) {
          console.error(`[email-watcher] Interview processing failed for "${email.subject}":`, err);
          agentNote = "\nInterview calendar processing failed. The email is still available for review.";
        }
      }

      const interviewWasScheduled = interview?.scheduled === true;
      const needsReply = interview?.analysis.requiresReply === true;

      if (route === "i9_compliance") {
        try {
          const result = await routeToThemis(user.id, { ...email, body: body || undefined });
          draftActionId = result.action.id;
          agentNote += `\nThemis drafted a grounded reply (approval ID: ${result.action.id.slice(0, 8)}).`;
        } catch (err) {
          console.error(`[email-watcher] Themis handoff failed for "${email.subject}":`, err);
          agentNote += "\nThemis handoff failed. See logs.";
        }
      } else if ((route === "recruiter" || route === "job_application") && (!interviewWasScheduled || needsReply)) {
        try {
          const result = await routeToAthena(user.id, { ...email, body: body || undefined });
          draftActionId = result.action.id;
          const trackerNote = result.isNewApp ? "New application logged." : "Tracker updated.";
          agentNote += `\nAthena drafted a reply. ${trackerNote} (approval ID: ${result.action.id.slice(0, 8)}).`;
        } catch (err) {
          console.error(`[email-watcher] Athena handoff failed for "${email.subject}":`, err);
          agentNote += "\nAthena handoff failed. See logs.";
        }
      } else if (interviewWasScheduled && !needsReply) {
        agentNote += "\nNo reply draft was created because this looks like a confirmed calendar commitment, not a request for a response.";
      }

      const fromDisplay = email.from.includes("<")
        ? email.from.split("<")[0].trim().replace(/^"|"$/g, "")
        : email.from;
      const routeLabel = interviewWasScheduled ? "Interview scheduled" : (ROUTE_LABEL[route] ?? "Action needed");
      const agentAction = interviewWasScheduled ? "Kairos processed the calendar commitment." : AGENT_LABEL[route];

      const lines = [
        `📬 *${routeLabel}*`,
        `*From:* ${fromDisplay}`,
        `*Subject:* ${email.subject}`,
        `*Preview:* ${email.snippet.slice(0, 160)}${email.snippet.length > 160 ? "…" : ""}`,
        ...calendarLines(interview),
        agentAction ? `\n${agentAction}` : "",
        agentNote,
      ].filter(Boolean);

      const buttons: InlineButton[][] | undefined = draftActionId
        ? [[
            { text: "✅ Review Draft", callback_data: `approve ${draftActionId}`.slice(0, 64) },
            { text: "👁 Mark Read", callback_data: `mark as read: ${email.subject.slice(0, 30)}` },
          ]]
        : undefined;

      if (OWNER_CHAT_ID) {
        try {
          await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n"), buttons);
        } catch (err) {
          console.error(`[email-watcher] Telegram send failed for "${email.subject}":`, err);
        }
      }

      await prisma.agentRun.create({
        data: {
          agentName: "email-watcher",
          inputSummary: `email=${email.id} mode=${fastMode ? "fast" : "broad"} route=${route} from=${email.from.slice(0, 60)}`,
          outputSummary: [
            interviewWasScheduled
              ? `calendar=${interview?.created ? "created" : "already_exists"}`
              : "calendar=not_scheduled",
            `reply=${draftActionId ? "draft_queued" : "not_needed"}`,
            `subject=${email.subject.slice(0, 100)}`,
          ].join(" | "),
          status: "completed",
        },
      });
      processed.push(`${routeLabel}: ${email.subject}`);
    }
  }

  if (users.length > 0 && disconnectedUsers === users.length) {
    return Response.json(
      { ok: false, job: "email-watcher", reason: "No connected Google account with Gmail scope. Reconnect Google from Health Center." },
      { status: 503 }
    );
  }

  return Response.json({
    ok: true,
    job: "email-watcher",
    mode: fastMode ? "fast" : "broad",
    processed,
    telegramConfigured: Boolean(OWNER_CHAT_ID),
  });
}
