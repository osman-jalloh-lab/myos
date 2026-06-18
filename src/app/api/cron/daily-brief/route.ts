// Vercel Cron: daily-brief. Schedule defined in vercel.json (UTC).
// Generates and persists today's brief for every user via Argus.morningBrief,
// then sends it to Telegram so Osman wakes up to a morning summary.
import { prisma } from "@/lib/db";
import { morningBrief } from "@/agents/argus";
import { sendTelegramMessage, ensureWebhookRegistered } from "@/lib/telegram";

const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;
const WEBHOOK_URL = "https://www.parawi.com/api/telegram/webhook";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  await ensureWebhookRegistered(WEBHOOK_URL);

  const users = await prisma.user.findMany({ select: { id: true, primaryEmail: true } });

  const results = await Promise.allSettled(
    users.map(async (user) => {
      const brief = await morningBrief(user.id);

      // Send morning brief to Telegram
      if (OWNER_CHAT_ID) {
        const todayStr = new Date().toDateString();
        const tomorrowStr = new Date(Date.now() + 86_400_000).toDateString();
        const todayEvents = brief.signals.events.filter((e) => new Date(e.start).toDateString() === todayStr);
        const tomorrowEvents = brief.signals.events.filter((e) => new Date(e.start).toDateString() === tomorrowStr);

        const lines = ["*Good morning — here's your day:*", ""];
        lines.push(brief.text);

        if (tomorrowEvents.length) {
          lines.push("");
          lines.push(`*Tomorrow (${tomorrowEvents.length} event${tomorrowEvents.length !== 1 ? "s" : ""}):`);
          for (const e of tomorrowEvents.slice(0, 4)) {
            const t = e.allDay
              ? "all day"
              : new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
            lines.push(`  ${t} — ${e.summary}`);
          }
        } else if (todayEvents.length === 0) {
          lines.push("\nNothing on the calendar today or tomorrow.");
        }

        if (brief.risks.length) {
          lines.push(`\n⚠️ ${brief.risks.length} email${brief.risks.length !== 1 ? "s" : ""} flagged — check inbox.`);
        }

        await sendTelegramMessage(OWNER_CHAT_ID, lines.join("\n")).catch((err) =>
          console.error("[daily-brief] Telegram send failed:", err)
        );
      }

      return user.primaryEmail;
    })
  );

  const generated = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);
  const failed = results
    .map((r, i) => (r.status === "rejected" ? users[i].primaryEmail : null))
    .filter((email): email is string => email !== null);

  return Response.json({ ok: true, job: "daily-brief", generated, failed });
}
