// Local worker liveness watch.
//
// The local worker on Osman's HP laptop is the ONLY thing that actually builds
// (Vercel just queues — see the architecture rule in the fix-and-harden brief).
// If it stops, every build request sits in queued_for_local_worker forever with
// no signal. This module turns that silence into: (a) a Telegram alert from the
// worker-watch cron, and (b) an explicit warning line appended to any chat
// response that queues a build while the worker is down.

import { prisma } from "@/lib/db";
import { sendTelegramMessage } from "@/lib/telegram";

export type WorkerLiveness = {
  status: "online" | "stale" | "offline" | "unknown";
  lastHeartbeat: string | null;
  machineName: string | null;
  ageMs: number | null;
  currentTask: string | null;
};

const HEARTBEAT_MS = Number(process.env.HERMES_LOCAL_WORKER_HEARTBEAT_MS ?? 15_000);
// Stale at ~2× the heartbeat interval; offline at 90s to match the Health
// Center's localWorkerStatus thresholds so the two never disagree.
const STALE_AFTER_MS = HEARTBEAT_MS * 2;
const OFFLINE_AFTER_MS = Math.max(90_000, HEARTBEAT_MS * 6);
const ALERT_DEDUP_MS = 6 * 60 * 60 * 1000; // one alert per offline episode, re-alert after 6h

type HeartbeatRow = {
  status: string;
  lastHeartbeat: string;
  machineName: string | null;
  currentTask: string | null;
};

export async function getLocalWorkerLiveness(): Promise<WorkerLiveness> {
  const rows = await prisma
    .$queryRawUnsafe<HeartbeatRow[]>(
      `SELECT status, lastHeartbeat, machineName, currentTask FROM LocalWorkerHeartbeat ORDER BY lastHeartbeat DESC LIMIT 1`
    )
    .catch(() => [] as HeartbeatRow[]);
  const row = rows[0];
  if (!row) return { status: "unknown", lastHeartbeat: null, machineName: null, ageMs: null, currentTask: null };

  const ageMs = Date.now() - new Date(row.lastHeartbeat).getTime();
  const status: WorkerLiveness["status"] =
    row.status === "offline" || ageMs > OFFLINE_AFTER_MS ? "offline" : ageMs > STALE_AFTER_MS ? "stale" : "online";
  return {
    status,
    lastHeartbeat: row.lastHeartbeat,
    machineName: row.machineName,
    ageMs,
    currentTask: row.currentTask,
  };
}

/**
 * One-line warning to append to chat/build responses when the worker cannot
 * pick the task up right now. Returns null when the worker is healthy.
 */
export function workerOfflineNotice(liveness: WorkerLiveness): string | null {
  if (liveness.status === "online") return null;
  if (liveness.status === "unknown") {
    return "⚠️ No local worker has ever reported in — nothing is building right now. Start it on the HP laptop with: npm run worker:local";
  }
  const last = liveness.lastHeartbeat ? new Date(liveness.lastHeartbeat).toLocaleString() : "unknown";
  return `⚠️ Local worker is ${liveness.status} (last heartbeat: ${last}) — this task is queued but nothing is building right now. Start it on the HP laptop with: npm run worker:local`;
}

// ── Hermes Nous (hermes_agent) readiness ─────────────────────────────────────
// Read from the capability flags the worker already reports on every heartbeat
// (getCapabilities() in scripts/hermes-local-worker.ts) — do not re-detect.

export type HermesAgentReadiness = { ready: boolean; reason: string | null };

type CapabilityRow = {
  hermesAgentAvailable: number | bigint | boolean | null;
  hermesAgentAuthConfigured: number | bigint | boolean | null;
  hermesAgentModelConfigured: number | bigint | boolean | null;
};

function flag(value: number | bigint | boolean | null): boolean {
  return value === true || Number(value ?? 0) === 1;
}

export async function getHermesAgentReadiness(): Promise<HermesAgentReadiness> {
  const rows = await prisma
    .$queryRawUnsafe<CapabilityRow[]>(
      `SELECT hermesAgentAvailable, hermesAgentAuthConfigured, hermesAgentModelConfigured FROM LocalWorkerHeartbeat ORDER BY lastHeartbeat DESC LIMIT 1`
    )
    .catch(() => [] as CapabilityRow[]);
  const row = rows[0];
  if (!row) return { ready: false, reason: "no local worker has ever reported in" };
  if (!flag(row.hermesAgentAvailable)) return { ready: false, reason: "Hermes Nous is not installed on the worker machine" };
  if (!flag(row.hermesAgentAuthConfigured)) return { ready: false, reason: "Hermes Nous auth is not configured (run `hermes auth` on the worker machine)" };
  if (!flag(row.hermesAgentModelConfigured)) return { ready: false, reason: "Hermes Nous has no model/provider selected (run `hermes model` on the worker machine)" };
  return { ready: true, reason: null };
}

/**
 * Cron entry point: alert Osman on Telegram when the worker goes offline, once
 * per offline episode (deduped via worker-watch AgentRun records), and record
 * recovery so the next outage alerts again.
 */
export async function checkLocalWorkerAndAlert(): Promise<{ status: WorkerLiveness["status"]; alerted: boolean }> {
  const liveness = await getLocalWorkerLiveness();
  const offline = liveness.status === "offline" || liveness.status === "unknown";

  const lastWatch = await prisma.agentRun
    .findFirst({ where: { agentName: "worker-watch" }, orderBy: { createdAt: "desc" } })
    .catch(() => null);
  const lastWasOffline = lastWatch?.inputSummary?.includes("state=offline") ?? false;
  const lastIsRecent = lastWatch ? Date.now() - lastWatch.createdAt.getTime() < ALERT_DEDUP_MS : false;

  if (!offline) {
    if (lastWasOffline) {
      await prisma.agentRun.create({
        data: {
          agentName: "worker-watch",
          inputSummary: "state=online",
          outputSummary: "Local worker heartbeat recovered.",
          modelProvider: "internal",
          status: "completed",
        },
      }).catch(() => undefined);
    }
    return { status: liveness.status, alerted: false };
  }

  if (lastWasOffline && lastIsRecent) return { status: liveness.status, alerted: false };

  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  let alerted = false;
  if (chatId) {
    const last = liveness.lastHeartbeat ? new Date(liveness.lastHeartbeat).toLocaleString() : "never";
    await sendTelegramMessage(
      chatId,
      [
        "🔴 Local worker offline — nothing is building right now.",
        `Last heartbeat: ${last}${liveness.machineName ? ` (${liveness.machineName})` : ""}`,
        "Queued builds will wait until it restarts. On the HP laptop run: npm run worker:local",
      ].join("\n")
    ).then(() => { alerted = true; }).catch(() => undefined);
  }

  await prisma.agentRun.create({
    data: {
      agentName: "worker-watch",
      inputSummary: "state=offline",
      outputSummary: alerted
        ? "Local worker offline — Telegram alert sent."
        : "Local worker offline — Telegram alert failed or not configured.",
      modelProvider: "internal",
      status: alerted ? "completed" : "failed",
    },
  }).catch(() => undefined);

  return { status: liveness.status, alerted };
}
