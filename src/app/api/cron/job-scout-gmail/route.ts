// Vercel Cron: job-scout-gmail. Schedule: daily at 14:00 UTC (9 AM CT).
// Runs the Gmail-alert pipeline: parse alerts → score leads → build kits → Telegram digest.
// Additive alongside the existing /api/cron/job-scout (JSearch path) — both are safe to coexist.
// NEVER submits or sends applications — all outbound actions are ApprovalAction queue items.
import { prisma } from "@/lib/db";
import { runJobScoutPipeline } from "@/lib/job-scout/pipeline";
import { sendTelegramMessage } from "@/lib/telegram";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const allResults = [];

  for (const user of users) {
    try {
      const result = await runJobScoutPipeline(user.id);
      allResults.push({ userId: user.id, ...result });

      // Telegram digest for strong matches
      if (result.topLeads.length > 0 && process.env.TELEGRAM_OWNER_CHAT_ID) {
        const highFit = result.topLeads.filter((l) => l.fitScore >= 70);
        if (highFit.length > 0) {
          const lines = highFit.map((l) => {
            const link = l.url ? `\n  ${l.url}` : "";
            return `${l.title} @ ${l.company} — ${l.fitScore}% fit${link}`;
          });
          const kitNote =
            result.kitsBuilt > 0
              ? `\n\nGenerated ${result.kitsBuilt} application kit${result.kitsBuilt !== 1 ? "s" : ""}${result.draftsQueued > 0 ? ` (${result.draftsQueued} draft${result.draftsQueued !== 1 ? "s" : ""} queued for review)` : ""}.`
              : "";
          try {
            await sendTelegramMessage(
              process.env.TELEGRAM_OWNER_CHAT_ID,
              `Athena scanned ${result.emailsScanned} job alert${result.emailsScanned !== 1 ? "s" : ""} — ${result.leadsFound} new lead${result.leadsFound !== 1 ? "s" : ""}:\n\n${lines.join("\n\n")}${kitNote}`
            );
            await prisma.jobScoutRun.updateMany({
              where: { createdAt: { gte: new Date(Date.now() - 60_000) } },
              data: { digestSent: true },
            });
          } catch {
            // non-fatal — cron result still returns even if Telegram is down
          }
        }
      }
    } catch (err) {
      allResults.push({ userId: user.id, error: String(err) });
    }
  }

  return Response.json({ ok: true, job: "job-scout-gmail", results: allResults });
}
