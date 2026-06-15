// Hermes OS bridge — structured context snapshot for Claude Code sessions.
// Claude Code calls this at the start of every session so it already knows
// Osman's inbox, calendar, job status, finance, and pending decisions without
// him having to repeat himself each time.
//
// Auth: Authorization: Bearer <HERMES_BRIDGE_KEY>
// The key lives in Vercel env vars (never in source) and in the local MCP
// server config at ~/.claude/hermes-mcp/ (never in any committed file).
//
// Payload is designed to be consumed by an LLM — every field is plaintext-
// friendly JSON, no raw HTML, no base64 blobs.

import { prisma } from "@/lib/db";
import { calendarRead, conflictScan } from "@/agents/kairos";
import { triageInbox } from "@/agents/iris";
import { plutusReport } from "@/agents/plutus";
import { appTrackerSummary } from "@/agents/athena";
import { getContextCards, readMemory } from "@/agents/mnemosyne";
import { morningBrief } from "@/agents/argus";
import { approvalCounts, listApprovals } from "@/lib/approvals";
import { applicationSummary } from "@/lib/appTracker";
import { recentDecisions, recentRuns } from "@/agents/hermes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const bridgeKey = process.env.HERMES_BRIDGE_KEY;
  if (!bridgeKey) {
    return new Response("Bridge not configured (HERMES_BRIDGE_KEY not set)", { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${bridgeKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    return Response.json({ error: "No user row — sign in on dashboard first" }, { status: 503 });
  }

  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Fan out to all 9 agents in parallel — the bridge is always a fresh read.
  const [
    calendarResult,
    conflictsResult,
    inboxResult,
    financeResult,
    athenaResult,
    appliedResult,
    memoryResult,
    cardsResult,
    briefResult,
    approvalsResult,
    pendingResult,
    decisionsResult,
    runsResult,
  ] = await Promise.allSettled([
    calendarRead(user.id, now, weekOut),
    conflictScan(user.id, 7),
    triageInbox(user.id, 10),
    plutusReport(user.id),
    appTrackerSummary(user.id),
    applicationSummary(user.id),
    readMemory(user.id),
    getContextCards(user.id, "current priorities housing job finance health"),
    morningBrief(user.id),
    approvalCounts(user.id),
    listApprovals(user.id, "pending"),
    recentDecisions(10),
    recentRuns(20),
  ]);

  function ok<T>(r: PromiseSettledResult<T>): T | null {
    return r.status === "fulfilled" ? r.value : null;
  }

  const calendar = ok(calendarResult) ?? [];
  const conflicts = ok(conflictsResult) ?? { conflictCount: 0, conflicts: [] };
  const inbox = ok(inboxResult);
  const finance = ok(financeResult);
  const athena = ok(athenaResult);
  const applied = ok(appliedResult);
  const memory = ok(memoryResult) ?? [];
  const cards = ok(cardsResult) ?? [];
  const brief = ok(briefResult);
  const approvals = ok(approvalsResult);
  const pending = ok(pendingResult) ?? [];
  const decisions = ok(decisionsResult) ?? [];
  const runs = ok(runsResult) ?? [];

  // Recent thread-watcher nudges — open threads that need Osman's reply
  const openThreads = await prisma.agentRun.findMany({
    where: {
      agentName: "thread-watcher",
      createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    take: 8,
  });

  // Sanitize pending approval payloads — strip raw email bodies to prevent
  // this endpoint from leaking private content into Claude Code's context.
  const sanitizedPending = pending.slice(0, 10).map((a) => {
    const p = a.payload as Record<string, unknown>;
    return {
      id: a.id,
      actionType: a.actionType,
      createdAt: a.createdAt,
      summary: [
        p?.agentKey ? `Agent: ${p.agentKey}` : null,
        p?.emailFrom ? `From: ${String(p.emailFrom).slice(0, 60)}` : null,
        p?.emailSubject ? `Subject: ${String(p.emailSubject).slice(0, 80)}` : null,
        p?.company ? `Company: ${p.company}` : null,
        p?.title ? `Role: ${p.title}` : null,
        p?.fact ? `Fact: ${String(p.fact).slice(0, 100)}` : null,
      ].filter(Boolean).join(" | ") || a.actionType,
    };
  });

  const payload = {
    generatedAt: now.toISOString(),

    osman: {
      name: "Osman Jalloh",
      primaryEmail: "osman.jalloh@g.austincc.edu",
      location: "Austin, TX",
      timezone: "America/Chicago",
    },

    brief: brief?.text ?? null,

    calendar: {
      events: calendar.slice(0, 20).map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location ?? null,
      })),
      conflictCount: conflicts.conflictCount,
    },

    inbox: inbox
      ? {
          unread: inbox.unread,
          total: inbox.total,
          needsAttention: inbox.needsAttention.slice(0, 8).map((m) => ({
            from: m.from,
            subject: m.subject,
            receivedAt: m.receivedAt,
            accountEmail: m.accountEmail,
          })),
          categoryCounts: Object.fromEntries(
            Object.entries(inbox.byCategory).map(([k, v]) => [k, v.length])
          ),
        }
      : null,

    jobs: {
      applied: applied
        ? {
            total: applied.total,
            byStatus: applied.byStatus,
            urgent: applied.urgent.slice(0, 5).map((a) => ({
              company: a.companyName,
              role: a.jobTitle,
              status: a.status,
              contact: a.contactName ?? null,
            })),
            recent: applied.recent.slice(0, 6).map((a) => ({
              company: a.companyName,
              role: a.jobTitle,
              status: a.status,
            })),
          }
        : null,
      interested: athena
        ? {
            byStatus: athena.byStatus,
            recent: athena.recent.slice(0, 5),
          }
        : null,
    },

    finance: finance ?? null,

    memory: {
      facts: memory.slice(0, 15).map((m) => ({ fact: m.fact, source: m.source })),
      contextCards: cards.slice(0, 8),
    },

    approvals: {
      counts: approvals ?? { pending: 0, approved: 0, rejected: 0 },
      pending: sanitizedPending,
    },

    openThreads: openThreads.map((r) => ({
      summary: r.inputSummary,
      nudgedAt: r.createdAt.toISOString(),
    })),

    recentAgentActivity: runs.slice(0, 12).map((r) => ({
      agent: r.agentName,
      summary: r.outputSummary?.slice(0, 120) ?? null,
      model: r.modelProvider,
      at: r.createdAt,
    })),

    recentDecisions: decisions.slice(0, 6).map((d) => ({
      title: d.title,
      decision: d.decision,
      at: d.createdAt,
    })),
  };

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
