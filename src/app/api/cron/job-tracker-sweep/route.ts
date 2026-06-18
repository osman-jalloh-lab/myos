// Vercel Cron: job-tracker-sweep. Schedule: daily at 16:00 UTC (11 AM CT).
// Sweeps Gmail for the last 2 days for job application evidence.
// Logs new applications, updates existing records, and sends Telegram alerts
// for urgent items (Interview Request, Needs Reply).
// NEVER applies to jobs or sends emails — read + tracker DB writes only.
import { prisma } from "@/lib/db";
import { sweepGmailApplications } from "@/lib/appTracker";
import { sendTelegramMessage } from "@/lib/telegram";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const allResults = [];

  for (const user of users) {
    try {
      const result = await sweepGmailApplications(user.id);
      allResults.push({ userId: user.id, ...result });

      // Telegram alert for urgent items (Interview or Needs Reply)
      if (result.urgent.length > 0 && process.env.TELEGRAM_OWNER_CHAT_ID) {
        const lines = result.urgent.map(
          (u) => `${u.company} — ${u.role}\nStatus: ${u.status} (${u.emailType})`
        );
        try {
          await sendTelegramMessage(
            process.env.TELEGRAM_OWNER_CHAT_ID,
            `Job tracker sweep — ${result.urgent.length} urgent item${result.urgent.length !== 1 ? "s" : ""}:\n\n${lines.join("\n\n")}\n\nChecked ${result.emailsScanned} email${result.emailsScanned !== 1 ? "s" : ""}. New: ${result.newLogged}, Updated: ${result.updated}.`
          );
        } catch {
          // non-fatal — cron still logs even if Telegram is down
        }
      }

      // Log the sweep run to AgentRun audit trail
      await prisma.agentRun.create({
        data: {
          agentName: "athena",
          inputSummary: `job-tracker-sweep: ${result.emailsScanned} emails scanned`,
          outputSummary: `${result.newLogged} new, ${result.updated} updated, ${result.urgent.length} urgent`,
          status: result.errors.length > 0 ? "partial" : "completed",
        },
      });
    } catch (err) {
      allResults.push({ userId: user.id, error: String(err) });
    }
  }

  return Response.json({ ok: true, job: "job-tracker-sweep", results: allResults });
}
