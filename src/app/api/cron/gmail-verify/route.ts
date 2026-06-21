// Read-only Gmail account verification endpoint.
// Returns per-account sync status for all connected accounts — no writes, no sends.
// Auth: same CRON_SECRET as other cron routes.
//
// Response shape:
//   { ok: true, report: [{ userId, accountCount, accounts: [...], totalMessages }] }
//
// Each account entry: { maskedEmail, label, status, messagesScanned, messagesImported, lastSyncTime, errorRef? }
// status: "completed" | "failed" | "reauth_required"

import { prisma } from "@/lib/db";
import { syncGmailInbox } from "@/lib/gmail";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const report = [];

  for (const user of users) {
    try {
      const { messages, accounts } = await syncGmailInbox(user.id, 5);
      report.push({
        userId: user.id.slice(0, 8) + "...",
        accountCount: accounts.length,
        accounts: accounts.map((a) => ({
          maskedEmail: a.maskedEmail,
          label: a.label,
          status: a.status,
          messagesScanned: a.messagesScanned,
          messagesImported: a.messagesImported,
          lastSyncTime: a.lastSyncTime,
          errorRef: a.errorRef,
        })),
        totalMessages: messages.length,
      });
    } catch (err) {
      report.push({
        userId: user.id.slice(0, 8) + "...",
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
    }
  }

  return Response.json({ ok: true, job: "gmail-verify", report });
}
