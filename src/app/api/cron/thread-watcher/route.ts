// Vercel Cron: thread-watcher.
// Scans all linked Gmail accounts for threads where a real human sent the last
// message and Osman hasn't replied yet. Catches things the email-watcher misses
// because email-watcher only looks at NEW emails in the last 20 minutes —
// ongoing conversations that go stale fall through that net.
//
// Logic:
//   1. Fetch threads where last message is from a real human, > 24h old
//   2. Skip job-alert digests, automated senders, threads Osman already replied to
//   3. Classify: job-related threads get an urgency flag and optionally an Athena draft
//   4. Notify Telegram with the "waiting on you" context
//
// Nothing replies or sends automatically. Every thread is a nudge, not an action.

import { prisma } from "@/lib/db";
import { fetchOpenThreads } from "@/lib/gmail";
import { sendTelegramMessage } from "@/lib/telegram";
import { classifyEmailRoute, routeToAthena } from "@/lib/agentHandoff";
import type { InlineButton } from "@/lib/telegram";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // one nudge per thread per day
const STALE_AFTER_HOURS = 24;                 // flag threads silent for > 24h

// Urgency tiers based on staleness
function urgencyLabel(hours: number): string {
  if (hours >= 72) return "🔴 OVERDUE";
  if (hours >= 48) return "🟠 Stale";
  return "🟡 Needs reply";
}

function formatAge(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

// Extract a clean display name from "Name <email>" format
function displayName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from.split("@")[0];
}

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!OWNER_CHAT_ID) {
    return Response.json({ ok: false, reason: "TELEGRAM_OWNER_CHAT_ID not set" });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const now = new Date();
  const surfaced: string[] = [];

  for (const user of users) {
    let openThreads;
    try {
      openThreads = await fetchOpenThreads(user.id, STALE_AFTER_HOURS);
    } catch {
      continue;
    }

    for (const thread of openThreads) {
      // Dedup: skip if we already nudged this thread today
      const alreadyNudged = await prisma.agentRun.findFirst({
        where: {
          agentName: "thread-watcher",
          inputSummary: { contains: thread.threadId },
          createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
        },
      });
      if (alreadyNudged) continue;

      const route = classifyEmailRoute(
        thread.subject,
        thread.lastSnippet,
        thread.lastFrom,
      );
      const isJobThread = route === "recruiter" || route === "job_application";
      const urgency = urgencyLabel(thread.hoursSinceLastMessage);
      const age = formatAge(thread.hoursSinceLastMessage);
      const name = displayName(thread.lastFrom);

      // For job threads silent > 36h, queue an Athena draft reminder so Osman
      // has a reply ready when he sees the nudge
      let draftActionId: string | undefined;
      if (isJobThread && thread.hoursSinceLastMessage >= 36) {
        try {
          const result = await routeToAthena(user.id, {
            id: thread.lastMessageId,
            from: thread.lastFrom,
            subject: thread.subject,
            snippet: thread.lastSnippet,
          });
          draftActionId = result.action.id;
        } catch {
          // draft generation is best-effort; nudge still goes out
        }
      }

      const lines = [
        `${urgency} — *${age} without reply*`,
        `*From:* ${name}`,
        `*Subject:* ${thread.subject}`,
        `*Last message:* ${thread.lastSnippet.slice(0, 120)}${thread.lastSnippet.length > 120 ? "…" : ""}`,
        isJobThread ? "\nJob-related thread — reply keeps you in the running." : "",
        draftActionId ? `\nAthena has a draft reply queued.` : "",
      ].filter(Boolean);

      const buttons: InlineButton[][] = [
        [
          draftActionId
            ? { text: "✅ Review Draft", callback_data: `approve ${draftActionId}`.slice(0, 64) }
            : { text: "✏️ Draft Reply", callback_data: `draft a reply to ${name} about: ${thread.subject}`.slice(0, 64) },
          { text: "📧 View Thread", callback_data: `show thread: ${thread.subject.slice(0, 30)}` },
        ],
      ];

      try {
        await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n"), buttons);
        await prisma.agentRun.create({
          data: {
            agentName: "thread-watcher",
            inputSummary: `thread=${thread.threadId} from=${thread.lastFrom.slice(0, 60)} age=${thread.hoursSinceLastMessage}h`,
            outputSummary: `nudged: "${thread.subject.slice(0, 80)}"${draftActionId ? ` | draft=${draftActionId.slice(0, 8)}` : ""}`,
            status: "completed",
          },
        });
        surfaced.push(`${urgency}: ${thread.subject}`);
      } catch (err) {
        console.error(`[thread-watcher] Telegram send failed for "${thread.subject}":`, err);
      }
    }
  }

  return Response.json({ ok: true, job: "thread-watcher", surfaced });
}
