// Vercel Cron: meeting-reminder — runs every 5 minutes.
// Checks calendar for events starting in the next 10 minutes.
// Sends a Telegram heads-up if one is found. Deduplicates via AgentRun table
// so the same meeting never triggers more than one notification.

import { prisma } from "@/lib/db";
import { fetchCalendarEvents } from "@/lib/calendar";
import { sendTelegramMessage, ensureWebhookRegistered } from "@/lib/telegram";

const WEBHOOK_URL = "https://www.parawi.com/api/telegram/webhook";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const LOOKAHEAD_MS = 10 * 60 * 1000; // notify if meeting starts within 10 min
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // don't re-notify same event for 1 hour

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!OWNER_CHAT_ID) {
    return Response.json({ ok: false, reason: "TELEGRAM_OWNER_CHAT_ID not set" });
  }

  // Auto-register Telegram webhook if not already set (no-op if already correct)
  await ensureWebhookRegistered(WEBHOOK_URL);

  const users = await prisma.user.findMany({ select: { id: true } });
  const now = new Date();
  const windowEnd = new Date(now.getTime() + LOOKAHEAD_MS);
  const sent: string[] = [];
  const skipped: string[] = [];

  for (const user of users) {
    let events;
    try {
      events = await fetchCalendarEvents(user.id, now, windowEnd);
    } catch {
      continue;
    }

    for (const event of events) {
      const eventStart = new Date(event.start);
      const minsUntil = Math.round((eventStart.getTime() - now.getTime()) / 60_000);
      if (minsUntil < 0) continue; // already started

      // Dedup — skip if we already notified for this event in the last hour
      const alreadySent = await prisma.agentRun.findFirst({
        where: {
          agentName: "meeting-reminder",
          inputSummary: { contains: event.id },
          createdAt: { gte: new Date(now.getTime() - DEDUP_WINDOW_MS) },
        },
      });
      if (alreadySent) {
        skipped.push(event.id);
        continue;
      }

      // Build the notification message
      const timeStr = eventStart.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Chicago", // CST — Austin, TX
      });

      const lines = [
        `📅 *Meeting in ${minsUntil} min*`,
        `*${event.summary}*`,
        `🕐 ${timeStr}`,
      ];
      if (event.location) lines.push(`📍 ${event.location}`);
      if (event.description?.includes("meet.google.com") || event.location?.includes("meet.google.com")) {
        const meetUrl = (event.description ?? event.location ?? "").match(/https:\/\/meet\.google\.com\/[^\s"<>]+/)?.[0];
        if (meetUrl) lines.push(`🔗 ${meetUrl}`);
      }
      if (event.htmlLink) lines.push(`\n[Open in Google Calendar](${event.htmlLink})`);

      try {
        await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n"));
        await prisma.agentRun.create({
          data: {
            agentName: "meeting-reminder",
            inputSummary: `event=${event.id} summary=${event.summary}`,
            outputSummary: `notified ${minsUntil}min before`,
            status: "completed",
          },
        });
        sent.push(event.summary);
      } catch (err) {
        console.error(`[meeting-reminder] failed to notify for "${event.summary}":`, err);
      }
    }
  }

  return Response.json({ ok: true, job: "meeting-reminder", sent, skipped: skipped.length });
}
