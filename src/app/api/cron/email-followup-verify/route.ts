import { prisma } from "@/lib/db";
import {
  classify,
  fetchEmailBody,
  getCorrespondentGraph,
  syncGmailInbox,
  type EmailMessage,
} from "@/lib/gmail";
import { classifyEmailFollowUp, routeActionEmailFollowUp } from "@/lib/agentHandoff";

type VerificationHit = {
  emailId: string;
  threadId: string;
  accountLabel: string;
  accountEmail: string;
  from: string;
  subject: string;
  receivedAt: string;
  inboxClassification: "action_needed";
  followUpKind: "event" | "task";
  followUpReason: string;
  approvalId: string;
  approvalType: string;
  approvalStatus: string;
  approvalPayload: unknown;
  taskRowsCreatedWithoutApproval: number;
};

function maskAddress(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "****";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

function publicEmail(message: EmailMessage): Pick<VerificationHit, "emailId" | "threadId" | "accountLabel" | "accountEmail" | "from" | "subject" | "receivedAt" | "inboxClassification"> {
  return {
    emailId: message.id,
    threadId: message.threadId,
    accountLabel: message.accountLabel,
    accountEmail: maskAddress(message.accountEmail),
    from: message.from,
    subject: message.subject,
    receivedAt: message.receivedAt,
    inboxClassification: "action_needed",
  };
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const maxPerAccount = Math.min(Number(url.searchParams.get("maxPerAccount") ?? 60), 100);
  const users = await prisma.user.findMany({ select: { id: true, primaryEmail: true } });
  const checkedAt = new Date().toISOString();
  const usersOut: Array<{
    user: string;
    accounts: number;
    scanned: number;
    actionNeeded: number;
    event: VerificationHit | null;
    task: VerificationHit | null;
    candidates: Array<{
      subject: string;
      from: string;
      kind: string;
      reason: string;
      receivedAt: string;
    }>;
  }> = [];

  for (const user of users) {
    const [sync, correspondents] = await Promise.all([
      syncGmailInbox(user.id, maxPerAccount),
      getCorrespondentGraph(user.id),
    ]);
    const actionNeeded = sync.messages.filter((message) => classify(message, { correspondents }) === "action_needed");
    const selected: { event: VerificationHit | null; task: VerificationHit | null } = { event: null, task: null };
    const candidates: Array<{ subject: string; from: string; kind: string; reason: string; receivedAt: string }> = [];

    for (const message of actionNeeded) {
      if (selected.event && selected.task) break;
      const body = await fetchEmailBody(user.id, message.accountEmail, message.id).catch(() => "");
      const classification = classifyEmailFollowUp(message.subject, message.snippet, message.from, body || undefined);
      candidates.push({
        subject: message.subject,
        from: message.from,
        kind: classification.kind,
        reason: classification.reason,
        receivedAt: message.receivedAt,
      });
      if (classification.kind !== "event" && classification.kind !== "task") continue;
      if (selected[classification.kind]) continue;

      const beforeTaskRows = await prisma.task.count({
        where: { userId: user.id, sourceRef: `gmail:${message.accountEmail}:${message.id}` },
      });
      const routed = await routeActionEmailFollowUp(user.id, { ...message, body: body || undefined });
      if (!routed.action) continue;
      const afterTaskRows = await prisma.task.count({
        where: { userId: user.id, sourceRef: `gmail:${message.accountEmail}:${message.id}` },
      });

      selected[classification.kind] = {
        ...publicEmail(message),
        followUpKind: classification.kind,
        followUpReason: classification.reason,
        approvalId: routed.action.id,
        approvalType: routed.action.actionType,
        approvalStatus: routed.action.status,
        approvalPayload: routed.action.payload,
        taskRowsCreatedWithoutApproval: afterTaskRows - beforeTaskRows,
      };
    }

    usersOut.push({
      user: maskAddress(user.primaryEmail),
      accounts: sync.accounts.length,
      scanned: sync.messages.length,
      actionNeeded: actionNeeded.length,
      event: selected.event,
      task: selected.task,
      candidates: candidates.slice(0, 20),
    });
  }

  return Response.json({
    ok: usersOut.some((user) => user.event && user.task),
    checkedAt,
    job: "email-followup-verify",
    users: usersOut,
  });
}
