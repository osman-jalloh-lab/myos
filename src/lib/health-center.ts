import { prisma } from "@/lib/db";
import { getCodexCliStatus } from "@/lib/local-builder";

type HealthSeverity = "healthy" | "warning" | "failure";

export type HealthAccount = {
  name: string;
  connected: boolean;
  lastSuccessfulSync: string | null;
  lastError: string | null;
  reconnectRequired: boolean;
  warnings: string[];
  score: number;
};

export type ScheduledJobHealth = {
  name: string;
  key: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastResult: string | null;
  runtime: string | null;
  successCount: number;
  failureCount: number;
  status: "Healthy" | "Delayed" | "Failed" | "Never Ran" | "Disabled";
};

export type ExecutorHealthRow = {
  name: string;
  status: "Online" | "Offline" | "Busy";
  lastRun: string | null;
  lastError: string | null;
};

export type NotificationHealthRow = {
  name: string;
  lastSent: string | null;
  lastFailed: string | null;
  pendingNotifications: number;
  status: HealthSeverity;
};

export type HealthLogEntry = {
  timestamp: string;
  component: string;
  status: HealthSeverity;
  message: string;
};

export type HealthCenterSnapshot = {
  overall: {
    status: HealthSeverity;
    score: number;
    message: string;
    lastChecked: string;
  };
  accounts: HealthAccount[];
  scheduledJobs: ScheduledJobHealth[];
  executors: ExecutorHealthRow[];
  notifications: NotificationHealthRow[];
  logs: HealthLogEntry[];
};

type QueueHealthRow = {
  status: string;
  assigned_executor: string | null;
};

type AgentRunRow = {
  agentName: string;
  inputSummary: string | null;
  outputSummary: string | null;
  status: string;
  createdAt: Date;
};

function iso(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  return typeof date === "string" ? date : date.toISOString();
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function includesAny(value: string | null | undefined, terms: string[]): boolean {
  const haystack = `${value ?? ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function latestRun(runs: AgentRunRow[], terms: string[]): AgentRunRow | null {
  return runs.find((run) => {
    const text = `${run.agentName} ${run.inputSummary ?? ""} ${run.outputSummary ?? ""}`;
    return includesAny(text, terms);
  }) ?? null;
}

function countRuns(runs: AgentRunRow[], terms: string[], status: "success" | "failure"): number {
  return runs.filter((run) => {
    const text = `${run.agentName} ${run.inputSummary ?? ""} ${run.outputSummary ?? ""}`;
    const matches = includesAny(text, terms);
    if (!matches) return false;
    const failed = /fail|error/i.test(run.status) || /fail|error/i.test(`${run.inputSummary ?? ""} ${run.outputSummary ?? ""}`);
    return status === "failure" ? failed : !failed;
  }).length;
}

function accountHealthScore(account: HealthAccount): number {
  let score = 100;
  if (!account.connected) score -= 60;
  if (account.reconnectRequired) score -= 30;
  if (account.lastError) score -= 20;
  if (!account.lastSuccessfulSync) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function jobStatus(lastRun: AgentRunRow | null, failures: number, enabled: boolean): ScheduledJobHealth["status"] {
  if (!enabled) return "Disabled";
  if (!lastRun) return "Never Ran";
  if (failures > 0 && /fail|error/i.test(`${lastRun.status} ${lastRun.outputSummary ?? ""}`)) return "Failed";
  const ageMs = Date.now() - lastRun.createdAt.getTime();
  if (ageMs > 8 * 24 * 60 * 60 * 1000) return "Delayed";
  return "Healthy";
}

function nextRunLabel(schedule: string): string {
  return `Vercel cron: ${schedule}`;
}

function runtimeLabel(run: AgentRunRow | null): string | null {
  if (!run) return null;
  return "recorded";
}

function executorStatus(latest: AgentRunRow | null, active: boolean, available = true): ExecutorHealthRow["status"] {
  if (active) return "Busy";
  if (!available) return "Offline";
  return "Online";
}

async function logHealth(component: string, status: HealthSeverity, message: string): Promise<void> {
  await prisma.agentRun.create({
    data: {
      agentName: "health-center",
      inputSummary: `health_check component=${component}`,
      outputSummary: message.slice(0, 2000),
      modelProvider: "internal",
      status,
    },
  }).catch(() => undefined);
}

export async function createHealthLog(component: string, status: HealthSeverity, message: string): Promise<void> {
  await logHealth(component, status, message);
}

export async function logHealthSnapshot(snapshot: HealthCenterSnapshot): Promise<void> {
  await Promise.all([
    logHealth("health-center", snapshot.overall.status, snapshot.overall.message),
    logHealth(
      "connected-accounts",
      snapshot.accounts.some((account) => account.reconnectRequired || account.lastError) ? "failure" : "healthy",
      `${snapshot.accounts.filter((account) => account.connected).length}/${snapshot.accounts.length} accounts connected`
    ),
    logHealth(
      "scheduled-jobs",
      snapshot.scheduledJobs.some((job) => job.status === "Failed") ? "failure" : snapshot.scheduledJobs.some((job) => job.status === "Delayed" || job.status === "Never Ran") ? "warning" : "healthy",
      snapshot.scheduledJobs.map((job) => `${job.name}: ${job.status}`).join(" | ")
    ),
    logHealth(
      "executor-health",
      snapshot.executors.some((executor) => executor.status === "Offline" && executor.lastError) ? "failure" : snapshot.executors.some((executor) => executor.status === "Offline") ? "warning" : "healthy",
      snapshot.executors.map((executor) => `${executor.name}: ${executor.status}`).join(" | ")
    ),
    logHealth(
      "notification-health",
      snapshot.notifications.some((notification) => notification.status === "failure") ? "failure" : snapshot.notifications.some((notification) => notification.status === "warning") ? "warning" : "healthy",
      snapshot.notifications.map((notification) => `${notification.name}: ${notification.status}`).join(" | ")
    ),
  ]);
}

export async function getHealthCenterSnapshot(userId: string): Promise<HealthCenterSnapshot> {
  const [accounts, runs, queueTasks, trackedCount, jobLeadCount, codexStatus, recentApprovals] = await Promise.all([
    prisma.googleAccount.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }),
    prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 250 }),
    prisma.$queryRawUnsafe<QueueHealthRow[]>(`SELECT status, assigned_executor FROM AgentTask WHERE userId = ? ORDER BY updatedAt DESC LIMIT 80`, userId).catch(() => []),
    prisma.trackedApplication.count({ where: { userId } }).catch(() => 0),
    prisma.jobLead.count({ where: { userId } }).catch(() => 0),
    getCodexCliStatus().catch(() => ({ installed: false, available: false, version: null, message: "Codex CLI status unavailable." })),
    prisma.approvalAction.findMany({ where: { userId, status: "pending" }, take: 25 }).catch(() => []),
  ]);

  const accountSlots = ["Gmail Account 1", "Gmail Account 2", "Gmail Account 3"];
  const gmailSync = latestRun(runs, ["gmail_sync_completed", "gmail", "email-watcher"]);
  const accountRows: HealthAccount[] = accountSlots.map((name, index) => {
    const account = accounts[index];
    const expired = account ? account.expiresAt.getTime() <= Date.now() : false;
    const warnings = [
      !account ? "account disconnected" : null,
      expired ? "token expired" : null,
    ].filter((item): item is string => Boolean(item));
    const row: HealthAccount = {
      name,
      connected: Boolean(account) && !expired,
      lastSuccessfulSync: gmailSync && !/fail|error/i.test(gmailSync.status) ? iso(gmailSync.createdAt) : null,
      lastError: expired ? "OAuth token expired" : !account ? "No linked Google account" : null,
      reconnectRequired: !account || expired,
      warnings,
      score: 0,
    };
    row.score = accountHealthScore(row);
    return row;
  });

  const calendarAccount = accounts.find((account) => /calendar/i.test(account.scopes));
  const calendarExpired = calendarAccount ? calendarAccount.expiresAt.getTime() <= Date.now() : false;
  const calendarRow: HealthAccount = {
    name: "Google Calendar",
    connected: Boolean(calendarAccount) && !calendarExpired,
    lastSuccessfulSync: iso(latestRun(runs, ["daily-brief", "calendar", "meeting-reminder"])?.createdAt),
    lastError: calendarExpired ? "OAuth token expired" : !calendarAccount ? "No Google account with calendar scope" : null,
    reconnectRequired: !calendarAccount || calendarExpired,
    warnings: [calendarExpired ? "token expired" : null, !calendarAccount ? "account disconnected" : null].filter((item): item is string => Boolean(item)),
    score: 0,
  };
  calendarRow.score = accountHealthScore(calendarRow);

  const telegramConnected = hasEnv("TELEGRAM_BOT_TOKEN") && hasEnv("TELEGRAM_OWNER_CHAT_ID");
  const telegramFailed = latestRun(runs, ["telegram send failed", "Telegram send failed"]);
  const telegramRow: HealthAccount = {
    name: "Telegram",
    connected: telegramConnected,
    lastSuccessfulSync: iso(latestRun(runs, ["telegram", "daily-brief", "email-watcher"])?.createdAt),
    lastError: telegramConnected ? (telegramFailed ? telegramFailed.outputSummary : null) : "Telegram env is not configured",
    reconnectRequired: !telegramConnected,
    warnings: telegramConnected ? [] : ["account disconnected"],
    score: 0,
  };
  telegramRow.score = accountHealthScore(telegramRow);

  const githubConnected = hasEnv("GITHUB_TOKEN");
  const githubRow: HealthAccount = {
    name: "GitHub",
    connected: githubConnected,
    lastSuccessfulSync: iso(latestRun(runs, ["github-scout", "github"])?.createdAt),
    lastError: githubConnected ? null : "GITHUB_TOKEN is not configured",
    reconnectRequired: !githubConnected,
    warnings: githubConnected ? [] : ["account disconnected"],
    score: 0,
  };
  githubRow.score = accountHealthScore(githubRow);

  const jobTrackerRow: HealthAccount = {
    name: "Job Tracker",
    connected: trackedCount + jobLeadCount > 0,
    lastSuccessfulSync: iso(latestRun(runs, ["job-tracker", "job-scout", "job-scout-gmail"])?.createdAt),
    lastError: trackedCount + jobLeadCount > 0 ? null : "No tracked applications or job leads found",
    reconnectRequired: false,
    warnings: trackedCount + jobLeadCount > 0 ? [] : ["sync failed"],
    score: trackedCount + jobLeadCount > 0 ? 90 : 65,
  };

  const scheduledDefinitions = [
    { name: "Job Scout", key: "job-scout", terms: ["job-scout", "job-scout-gmail"], schedule: "0 13 * * 1 / 0 14 * * *", enabled: true },
    { name: "Email Scout", key: "email-watcher", terms: ["email-watcher", "thread-watcher"], schedule: "0 15 * * * / 0 18 * * *", enabled: true },
    { name: "Skill Scout", key: "skills-scout", terms: ["skills-scout", "skill scout", "sophos"], schedule: "30 13 * * 1", enabled: true },
    { name: "Daily Briefing", key: "daily-brief", terms: ["daily-brief", "morning brief"], schedule: "30 12 * * *", enabled: true },
    { name: "Memory Consolidation", key: "memory-consolidation", terms: ["memory", "mnemosyne", "memory consolidation"], schedule: "agent daily/weekly buckets", enabled: true },
  ];

  const scheduledJobs = scheduledDefinitions.map((job): ScheduledJobHealth => {
    const lastRun = latestRun(runs, job.terms);
    const failureCount = countRuns(runs, job.terms, "failure");
    const successCount = countRuns(runs, job.terms, "success");
    return {
      name: job.name,
      key: job.key,
      enabled: job.enabled,
      lastRun: iso(lastRun?.createdAt),
      nextRun: nextRunLabel(job.schedule),
      lastResult: lastRun?.outputSummary ?? lastRun?.inputSummary ?? null,
      runtime: runtimeLabel(lastRun),
      successCount,
      failureCount,
      status: jobStatus(lastRun, failureCount, job.enabled),
    };
  });

  const busyExecutors = new Set(queueTasks.filter((task) => ["queued", "planning", "executing", "running", "qa_pending"].includes(task.status)).map((task) => task.assigned_executor ?? task.status));
  const executorRows: ExecutorHealthRow[] = [
    { name: "Hermes", status: executorStatus(latestRun(runs, ["hermes"]), false, true), lastRun: iso(latestRun(runs, ["hermes"])?.createdAt), lastError: latestRun(runs, ["hermes"])?.status === "failed" ? latestRun(runs, ["hermes"])?.outputSummary ?? null : null },
    { name: "Builder", status: executorStatus(latestRun(runs, ["local_build", "hermes-local-builder"]), busyExecutors.has("hermes-local-builder"), true), lastRun: iso(latestRun(runs, ["local_build", "hermes-local-builder"])?.createdAt), lastError: latestRun(runs, ["local_build", "hermes-local-builder"])?.status === "failed" ? latestRun(runs, ["local_build", "hermes-local-builder"])?.outputSummary ?? null : null },
    { name: "Codex Executor", status: executorStatus(latestRun(runs, ["codex_cli"]), busyExecutors.has("codex_cli"), codexStatus.available), lastRun: iso(latestRun(runs, ["codex_cli"])?.createdAt), lastError: codexStatus.available ? latestRun(runs, ["codex_cli"])?.status === "failed" ? latestRun(runs, ["codex_cli"])?.outputSummary ?? null : null : codexStatus.message },
    { name: "Fugu Critic", status: executorStatus(latestRun(runs, ["fugu"]), false, hasEnv("SAKANA_API_KEY")), lastRun: iso(latestRun(runs, ["fugu"])?.createdAt), lastError: hasEnv("SAKANA_API_KEY") ? null : "SAKANA_API_KEY is not configured" },
    { name: "Job Tracker", status: executorStatus(latestRun(runs, ["job-tracker", "job-scout"]), false, true), lastRun: iso(latestRun(runs, ["job-tracker", "job-scout"])?.createdAt), lastError: latestRun(runs, ["job-tracker", "job-scout"])?.status === "failed" ? latestRun(runs, ["job-tracker", "job-scout"])?.outputSummary ?? null : null },
    { name: "Email Intelligence", status: executorStatus(latestRun(runs, ["email-watcher", "thread-watcher"]), false, accounts.length > 0), lastRun: iso(latestRun(runs, ["email-watcher", "thread-watcher"])?.createdAt), lastError: accounts.length > 0 ? null : "No Gmail account connected" },
  ];

  const notificationRows: NotificationHealthRow[] = [
    {
      name: "Telegram",
      lastSent: iso(latestRun(runs, ["telegram", "daily-brief", "email-watcher", "skills-scout"])?.createdAt),
      lastFailed: iso(latestRun(runs, ["telegram send failed", "Telegram send failed"])?.createdAt),
      pendingNotifications: 0,
      status: telegramConnected ? "healthy" : "failure",
    },
    {
      name: "Email",
      lastSent: iso(latestRun(runs, ["draft_email", "email"])?.createdAt),
      lastFailed: iso(latestRun(runs, ["email failed", "gmail not accessible"])?.createdAt),
      pendingNotifications: recentApprovals.filter((approval) => approval.actionType.includes("email")).length,
      status: accounts.length > 0 ? "healthy" : "warning",
    },
    {
      name: "Mission Control Alerts",
      lastSent: iso(latestRun(runs, ["health-center", "approval", "alert"])?.createdAt),
      lastFailed: null,
      pendingNotifications: recentApprovals.length,
      status: recentApprovals.length > 0 ? "warning" : "healthy",
    },
  ];

  const healthLogs = runs
    .filter((run) => run.agentName === "health-center")
    .slice(0, 30)
    .map((run): HealthLogEntry => ({
      timestamp: run.createdAt.toISOString(),
      component: run.inputSummary?.match(/component=([^\s]+)/)?.[1] ?? "health-center",
      status: run.status === "failure" || run.status === "failed" ? "failure" : run.status === "warning" ? "warning" : "healthy",
      message: run.outputSummary ?? run.inputSummary ?? "Health check recorded.",
    }));

  const failures = [
    ...accountRows.filter((row) => !row.connected || row.lastError),
    ...scheduledJobs.filter((job) => job.status === "Failed"),
    ...executorRows.filter((row) => row.status === "Offline" && row.lastError),
    ...notificationRows.filter((row) => row.status === "failure"),
  ].length;
  const warnings = [
    ...accountRows.filter((row) => row.warnings.length > 0),
    ...scheduledJobs.filter((job) => job.status === "Delayed" || job.status === "Never Ran"),
    ...notificationRows.filter((row) => row.status === "warning"),
  ].length;
  const accountScore = Math.round(accountRows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, accountRows.length));
  const jobScore = Math.round((scheduledJobs.filter((job) => job.status === "Healthy").length / Math.max(1, scheduledJobs.length)) * 100);
  const executorScore = Math.round((executorRows.filter((row) => row.status !== "Offline").length / Math.max(1, executorRows.length)) * 100);
  const notificationScore = Math.round((notificationRows.filter((row) => row.status === "healthy").length / Math.max(1, notificationRows.length)) * 100);
  const score = Math.round((accountScore + jobScore + executorScore + notificationScore) / 4);
  const status: HealthSeverity = failures > 0 ? "failure" : warnings > 0 ? "warning" : "healthy";

  return {
    overall: {
      status,
      score,
      message: status === "healthy" ? "Everything healthy" : status === "warning" ? "Warnings detected" : "Failures detected",
      lastChecked: new Date().toISOString(),
    },
    accounts: [...accountRows, calendarRow, telegramRow, githubRow, jobTrackerRow],
    scheduledJobs,
    executors: executorRows,
    notifications: notificationRows,
    logs: healthLogs,
  };
}
