// Agent task dispatcher — reads src/config/tasks.json and runs each task
// in the matching cadence bucket. Called by /api/cron/[bucket]/route.ts.
// Existing dedicated cron routes (daily-brief, job-scout, github-scout,
// skills-scout) keep their own schedules and are NOT replaced by this file.

import tasksData from "@/config/tasks.json";
import { prisma } from "@/lib/db";
import { morningBrief, synthesize, riskFlag } from "@/agents/argus";
import { triageInbox } from "@/agents/iris";
import { calendarRead, conflictScan } from "@/agents/kairos";
import { plutusReport } from "@/agents/plutus";
import { appTrackerSummary } from "@/agents/athena";
import { readMemory } from "@/agents/mnemosyne";
import { releaseWatch } from "@/agents/sophos";
import { incomeBrief, passiveIncomeScan, gigScout, campusJobScan } from "@/agents/tyche";
import { logHandoff, recentDecisions } from "@/agents/hermes";
import { listApprovals } from "@/lib/approvals";

export type Cadence = "daily_am" | "daily_pm" | "weekly" | "monthly" | "on_trigger";

export interface AgentTask {
  id: string;
  agent: string;
  cadence: Cadence;
  description: string;
  soul: string;
}

export interface TaskResult {
  id: string;
  agent: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

const tasks = tasksData as AgentTask[];

export function tasksForBucket(bucket: Cadence): AgentTask[] {
  return tasks.filter((t) => t.cadence === bucket);
}

export async function runDueTasks(bucket: Cadence): Promise<TaskResult[]> {
  const due = tasksForBucket(bucket);
  const results: TaskResult[] = [];

  for (const task of due) {
    try {
      const output = await runAgentTask(task);
      results.push({ id: task.id, agent: task.agent, ok: true, output });
    } catch (err) {
      results.push({
        id: task.id,
        agent: task.agent,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function getUsers() {
  return prisma.user.findMany({ select: { id: true, primaryEmail: true } });
}

async function runAgentTask(task: AgentTask): Promise<unknown> {
  // on_trigger tasks have no cron schedule — they fire when another agent or
  // Osman calls them directly. Return immediately so they don't block the bucket.
  if (task.cadence === "on_trigger") {
    return { skipped: true, reason: "on_trigger — fires when called directly, not via cron" };
  }

  const users = await getUsers();
  if (users.length === 0) {
    return { skipped: true, reason: "no users in db yet" };
  }

  const results: Record<string, unknown> = {};

  for (const user of users) {
    const userId = user.id;

    switch (task.id) {

      // ── HERMES ──────────────────────────────────────────────────────────────

      case "hermes.morning_brief": {
        const brief = await morningBrief(userId);
        await logHandoff({ agentName: "hermes", inputSummary: "morning_brief", outputSummary: brief.text.slice(0, 500) });
        results[userId] = { text: brief.text.slice(0, 300) };
        break;
      }

      case "hermes.eod_status": {
        const [pending, memories] = await Promise.all([
          listApprovals(userId, "pending"),
          readMemory(userId),
        ]);
        const summary = `EOD: ${pending.length} approvals pending, ${memories.length} memory facts stored.`;
        await logHandoff({ agentName: "hermes", inputSummary: "eod_status", outputSummary: summary });
        results[userId] = { pendingApprovals: pending.length, memoryFacts: memories.length };
        break;
      }

      case "hermes.agent_health_check": {
        const since = new Date(Date.now() - 7 * 86_400_000);
        const runs = await prisma.agentRun.groupBy({
          by: ["agentName"],
          where: { createdAt: { gte: since } },
          _max: { createdAt: true },
        });
        const allAgents = ["hermes", "iris", "kairos", "argus", "plutus", "athena", "mnemosyne", "sophos"];
        const active = new Set(runs.map((r) => r.agentName));
        const stalled = allAgents.filter((a) => !active.has(a));
        const summary = stalled.length === 0
          ? "All agents ran this week."
          : `Stalled this week: ${stalled.join(", ")}.`;
        await logHandoff({ agentName: "hermes", inputSummary: "agent_health_check", outputSummary: summary });
        results[userId] = { active: [...active], stalled };
        break;
      }

      case "hermes.top_decision": {
        const decisions = await recentDecisions(5);
        const summary = decisions.length > 0
          ? `Top recent decision: "${decisions[0].title}" — ${decisions[0].decision}`
          : "No decisions logged this week.";
        await logHandoff({ agentName: "hermes", inputSummary: "top_decision", outputSummary: summary });
        results[userId] = decisions.slice(0, 3);
        break;
      }

      // ── IRIS ─────────────────────────────────────────────────────────────────

      case "iris.triage_email": {
        const triage = await triageInbox(userId);
        const cats = Object.fromEntries(
          Object.entries(triage.byCategory).map(([k, v]) => [k, v.length])
        );
        const summary = `${triage.unread} unread of ${triage.total}. Categories: ${JSON.stringify(cats)}. Needs attention: ${triage.needsAttention.length}.`;
        await logHandoff({ agentName: "iris", inputSummary: "triage_email", outputSummary: summary });
        results[userId] = { unread: triage.unread, total: triage.total, categories: cats, needsAttention: triage.needsAttention.length };
        break;
      }

      case "iris.flag_stale_threads": {
        const triage = await triageInbox(userId);
        // Stale = older than 5 days and still in needs-attention
        const fiveDaysAgo = Date.now() - 5 * 86_400_000;
        const stale = triage.needsAttention.filter((m) => {
          const d = m.receivedAt ? new Date(m.receivedAt).getTime() : 0;
          return d > 0 && d < fiveDaysAgo;
        });
        const summary = stale.length > 0
          ? `${stale.length} threads 5+ days without reply: ${stale.slice(0, 3).map((m) => m.subject).join(", ")}`
          : "No stale threads needing attention.";
        await logHandoff({ agentName: "iris", inputSummary: "flag_stale_threads", outputSummary: summary });
        results[userId] = { staleCount: stale.length, samples: stale.slice(0, 3).map((m) => m.subject) };
        break;
      }

      // ── KAIROS ───────────────────────────────────────────────────────────────

      case "kairos.today_schedule": {
        const now = new Date();
        const weekOut = new Date(now.getTime() + 7 * 86_400_000);
        const events = await calendarRead(userId, now, weekOut);
        const today = events.filter((e) => {
          const d = new Date(e.start);
          return d.toDateString() === now.toDateString();
        });
        const summary = `Today: ${today.length} events. Next 7 days: ${events.length} total.`;
        await logHandoff({ agentName: "kairos", inputSummary: "today_schedule", outputSummary: summary });
        results[userId] = { today: today.length, week: events.length };
        break;
      }

      case "kairos.join_links": {
        const now = new Date();
        const weekOut = new Date(now.getTime() + 7 * 86_400_000);
        const events = await calendarRead(userId, now, weekOut);
        const missingLinks = events.filter(
          (e) => e.summary?.toLowerCase().includes("meeting") && !e.htmlLink && !e.description?.includes("http")
        );
        const summary = missingLinks.length > 0
          ? `${missingLinks.length} meetings may be missing join links: ${missingLinks.slice(0, 3).map((e) => e.summary).join(", ")}`
          : "All meetings appear to have links.";
        await logHandoff({ agentName: "kairos", inputSummary: "join_links", outputSummary: summary });
        results[userId] = { missingLinks: missingLinks.length };
        break;
      }

      case "kairos.week_ahead": {
        const now = new Date();
        const weekOut = new Date(now.getTime() + 7 * 86_400_000);
        const [events, conflicts] = await Promise.all([
          calendarRead(userId, now, weekOut),
          conflictScan(userId, 7),
        ]);
        const summary = `Week ahead: ${events.length} events, ${conflicts.conflictCount} conflict(s).`;
        await logHandoff({ agentName: "kairos", inputSummary: "week_ahead", outputSummary: summary });
        results[userId] = { events: events.length, conflicts: conflicts.conflictCount };
        break;
      }

      case "kairos.month_ahead": {
        const now = new Date();
        const monthOut = new Date(now.getTime() + 30 * 86_400_000);
        const events = await calendarRead(userId, now, monthOut);
        const summary = `Month ahead: ${events.length} events. Housing decision deadline: Aug 1. Watch I-9 reverification dates.`;
        await logHandoff({ agentName: "kairos", inputSummary: "month_ahead", outputSummary: summary });
        results[userId] = { events: events.length };
        break;
      }

      // ── ARGUS ────────────────────────────────────────────────────────────────

      case "argus.deploy_health": {
        const signals = await synthesize(userId);
        const flags = riskFlag(signals.inbox);
        const summary = `Deploy health check: ${flags.length} risk-flagged items. Vercel/Netlify status requires manual check.`;
        await logHandoff({ agentName: "argus", inputSummary: "deploy_health", outputSummary: summary });
        results[userId] = { riskFlags: flags.length };
        break;
      }

      case "argus.advisories_scan": {
        const notes = await releaseWatch().catch(() => null);
        const summary = notes
          ? `Advisories scanned. Latest: ${notes.slice(0, 300)}`
          : "Advisory scan unavailable this run.";
        await logHandoff({ agentName: "argus", inputSummary: "advisories_scan", outputSummary: summary });
        results[userId] = { available: !!notes };
        break;
      }

      case "argus.dependency_audit": {
        // Runtime audit via npm is not available in serverless; surface a reminder.
        const summary = "Weekly reminder: run `npm audit --audit-level=high` locally. Critical/high findings should be patched before next deploy.";
        await logHandoff({ agentName: "argus", inputSummary: "dependency_audit", outputSummary: summary });
        results[userId] = { reminder: summary };
        break;
      }

      case "argus.secret_check": {
        const summary = "Weekly secret check: confirm no env vars are in commit history or Vercel build logs. Review Vercel project settings > Environment Variables.";
        await logHandoff({ agentName: "argus", inputSummary: "secret_check", outputSummary: summary });
        results[userId] = { reminder: summary };
        break;
      }

      // ── PLUTUS ───────────────────────────────────────────────────────────────

      case "plutus.money_checkin": {
        const report = await plutusReport(userId);
        const summary = `Monthly check-in. Net: $${report.finance.net.toFixed(2)}. Expenses: $${report.finance.expenses.toFixed(2)}. Budget: ${report.budget.percentUsed}% used. Debt balance: $${(report.debt.currentBalance ?? 0).toFixed(2)} vs $5,092 goal.`;
        await logHandoff({ agentName: "plutus", inputSummary: "money_checkin", outputSummary: summary });
        results[userId] = { net: report.finance.net, expenses: report.finance.expenses, debtBalance: report.debt.currentBalance };
        break;
      }

      case "plutus.balance_burn": {
        const report = await plutusReport(userId);
        const flag = report.budget.level !== "ok" ? ` WARNING: budget level is ${report.budget.level}.` : "";
        const summary = `Weekly burn: $${report.finance.expenses.toFixed(2)} spent. LLM: $${report.budget.spentUsd.toFixed(4)} of $${report.budget.capUsd} cap (${report.budget.percentUsed}%).${flag}`;
        await logHandoff({ agentName: "plutus", inputSummary: "balance_burn", outputSummary: summary });
        results[userId] = { expenses: report.finance.expenses, budgetLevel: report.budget.level };
        break;
      }

      // ── ATHENA ───────────────────────────────────────────────────────────────

      case "athena.review_tracker": {
        const tracker = await appTrackerSummary(userId);
        const needFollowup = tracker.recent.filter((j) => j.status === "applied").length;
        const summary = `Weekly tracker review: ${tracker.recent.length} tracked. ${needFollowup} in "applied" — consider follow-up. By status: ${JSON.stringify(tracker.byStatus)}.`;
        await logHandoff({ agentName: "athena", inputSummary: "review_tracker", outputSummary: summary });
        results[userId] = { total: tracker.recent.length, needFollowup, byStatus: tracker.byStatus };
        break;
      }

      // ── MNEMOSYNE ────────────────────────────────────────────────────────────

      case "mnemosyne.log_day": {
        const [memories, pending] = await Promise.all([readMemory(userId), listApprovals(userId, "pending")]);
        const summary = `EOD memory log: ${memories.length} facts stored. ${pending.length} approvals still pending.`;
        await logHandoff({ agentName: "mnemosyne", inputSummary: "log_day", outputSummary: summary });
        results[userId] = { memoryFacts: memories.length, pendingApprovals: pending.length };
        break;
      }

      case "mnemosyne.weekly_summary": {
        const [memories, decisions] = await Promise.all([readMemory(userId), recentDecisions(10)]);
        const summary = `Weekly memory summary: ${memories.length} facts on record. ${decisions.length} decisions logged in the last 10.`;
        await logHandoff({ agentName: "mnemosyne", inputSummary: "weekly_summary", outputSummary: summary });
        results[userId] = { facts: memories.length, decisions: decisions.length };
        break;
      }

      case "mnemosyne.reconcile_context": {
        const summary = "Context reconciliation reminder: review OSMAN.md in src/agents/souls/ — update roles, balances, deadlines if anything changed this week.";
        await logHandoff({ agentName: "mnemosyne", inputSummary: "reconcile_context", outputSummary: summary });
        results[userId] = { reminder: summary };
        break;
      }

      // ── TYCHE ────────────────────────────────────────────────────────────────

      case "tyche.weekly_gig_scan": {
        const [gigs, campus] = await Promise.all([
          gigScout().catch(() => []),
          campusJobScan().catch(() => []),
        ]);
        const summary = `Gig scan: ${gigs.length} freelance listings, ${campus.length} on-campus listings found.`;
        await logHandoff({ agentName: "tyche", inputSummary: "weekly_gig_scan", outputSummary: summary });
        results[userId] = { gigs: gigs.length, campusJobs: campus.length, samples: [...gigs, ...campus].slice(0, 3).map((g) => g.title) };
        break;
      }

      case "tyche.passive_income_scan": {
        const passive = passiveIncomeScan();
        const summary = `Passive income scan: ${passive.length} standing opportunities. Top: ${passive[0]?.title ?? "none"}.`;
        await logHandoff({ agentName: "tyche", inputSummary: "passive_income_scan", outputSummary: summary });
        results[userId] = { count: passive.length, top: passive.slice(0, 3).map((p) => p.title) };
        break;
      }

      case "tyche.lavaall_leads": {
        const summary = "Monthly LAVAALL review: check Austin SMB IT contract boards (Clutch, Bark, Thumbtack) for hardware/support leads. Verify any new client vertical fits LAVAALL's current capacity.";
        await logHandoff({ agentName: "tyche", inputSummary: "lavaall_leads", outputSummary: summary });
        results[userId] = { reminder: summary };
        break;
      }

      default:
        throw new Error(`No handler for task "${task.id}" (cadence: ${task.cadence})`);
    }
  }

  return results;
}
