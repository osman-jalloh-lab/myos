import { prisma } from "@/lib/db";
import { redactExecutionText } from "@/lib/execution-runs";
import { getCodexCliStatus } from "@/lib/local-builder";
import { MODEL_PROVIDER_REGISTRY, providerComponent, selectedProviderModel, type ProviderEnvironment, type ProviderFamily, type ProviderRole } from "@/lib/model-provider-registry";

type HealthSeverity = "healthy" | "warning" | "failure";

export type HealthAccount = {
  name: string;
  connected: boolean;
  email?: string | null;
  label?: string | null;
  gmailScope?: boolean;
  calendarScope?: boolean;
  tokenExpiresAt?: string | null;
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
  status: "Ready" | "Online" | "Offline" | "Stale" | "Busy" | "Unknown";
  lastRun: string | null;
  lastError: string | null;
  workerId?: string | null;
  machineName?: string | null;
  rootPath?: string | null;
  nodeVersion?: string | null;
  npmVersion?: string | null;
  gitAvailable?: boolean | null;
  codexAvailable?: boolean | null;
  currentTask?: string | null;
  workerApiTarget?: string | null;
  lastFetchError?: string | null;
  capabilities?: string[];
};

export type HermesNousRuntimeHealth = {
  installed: boolean;
  installPath: string | null;
  version: string | null;
  authState: "configured" | "missing" | "unknown";
  selectedModelProvider: string;
  workerState: "online" | "offline" | "stale" | "busy" | "unknown";
  lastSuccessfulRun: string | null;
  lastFailure: string | null;
  currentActiveRun: string | null;
  supportedExecutionProfiles: string[];
  codexFallbackAvailable: boolean;
  diagnostic: string;
};

export type NotificationHealthRow = {
  name: string;
  lastSent: string | null;
  lastFailed: string | null;
  pendingNotifications: number;
  status: HealthSeverity;
};

export type ApiProviderStatus = "working" | "missing" | "invalid" | "error" | "configured_untested";

export type ApiProviderHealth = {
  provider: string;
  family?: ProviderFamily;
  role?: ProviderRole;
  roleLabel?: string;
  selectedModel?: string;
  environment?: ProviderEnvironment;
  routePreview?: string;
  council?: boolean;
  testable?: boolean;
  configured: boolean;
  requiredEnvVars: string[];
  source: "local env" | "Vercel/runtime";
  lastTested: string | null;
  status: ApiProviderStatus;
  safeError: string | null;
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
  hermesNousRuntime: HermesNousRuntimeHealth;
  notifications: NotificationHealthRow[];
  apiProviders: ApiProviderHealth[];
  logs: HealthLogEntry[];
};

type QueueHealthRow = {
  status: string;
  assigned_executor: string | null;
};

export type LocalWorkerHeartbeatRow = {
  workerId: string;
  machineName: string;
  status: string;
  lastHeartbeat: string;
  rootPath: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitAvailable: number | boolean | null;
  codexAvailable: number | boolean | null;
  currentTask: string | null;
  lastError: string | null;
  workerApiTarget: string | null;
  lastFetchError: string | null;
  hermesAgentAvailable: number | boolean | null;
  hermesAgentPath: string | null;
  hermesAgentVersion: string | null;
  hermesAgentAuthConfigured: number | boolean | null;
  hermesAgentModelConfigured: number | boolean | null;
  lastHermesAgentRun: string | null;
  lastHermesAgentError: string | null;
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

function hasGmailScope(scopes: string | null | undefined): boolean {
  return /gmail/i.test(scopes ?? "");
}

function hasCalendarScope(scopes: string | null | undefined): boolean {
  return /calendar/i.test(scopes ?? "");
}

function runtimeSource(): ApiProviderHealth["source"] {
  return process.env.VERCEL ? "Vercel/runtime" : "local env";
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

function latestHealthLog(runs: AgentRunRow[], component: string): AgentRunRow | null {
  return runs.find((run) => run.agentName === "health-center" && run.inputSummary === `api_provider_test component=${component}`) ?? null;
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

function localWorkerStatus(heartbeat: LocalWorkerHeartbeatRow | null): ExecutorHealthRow["status"] {
  if (!heartbeat) return "Unknown";
  const ageMs = Date.now() - new Date(heartbeat.lastHeartbeat).getTime();
  if (ageMs > 90 * 1000 || heartbeat.status === "offline") return "Offline";
  if (ageMs > 45 * 1000 || heartbeat.status === "stale") return "Stale";
  return heartbeat.currentTask ? "Busy" : "Online";
}

function safePathLabel(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const normalized = rawPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const file = parts.at(-1) ?? "hermes";
  const drive = rawPath.match(/^[A-Za-z]:/)?.[0] ?? null;
  const rootHint = drive ? `${drive}/` : rawPath.startsWith("/") ? "/" : "";
  return `${rootHint}.../${file}`;
}

function hermesWorkerState(heartbeat: LocalWorkerHeartbeatRow | null): HermesNousRuntimeHealth["workerState"] {
  const status = localWorkerStatus(heartbeat);
  if (status === "Online" || status === "Ready") return "online";
  if (status === "Busy") return "busy";
  if (status === "Stale") return "stale";
  if (status === "Offline") return "offline";
  return "unknown";
}

function hermesRuntimeDiagnostic(runtime: Omit<HermesNousRuntimeHealth, "diagnostic">): string {
  return redactExecutionText([
    "Hermes Nous Runtime Diagnostic",
    `Installed: ${runtime.installed ? "yes" : "no"}`,
    `Safe install path: ${runtime.installPath ?? "missing"}`,
    `Version: ${runtime.version ?? "unknown"}`,
    `Nous auth: ${runtime.authState}`,
    `Selected model/provider: ${runtime.selectedModelProvider}`,
    `Worker state: ${runtime.workerState}`,
    `Last successful run: ${runtime.lastSuccessfulRun ?? "none"}`,
    `Last failure: ${runtime.lastFailure ?? "none"}`,
    `Current active run: ${runtime.currentActiveRun ?? "none"}`,
    `Supported execution profiles: ${runtime.supportedExecutionProfiles.join(", ") || "none"}`,
    `Codex fallback available: ${runtime.codexFallbackAvailable ? "yes" : "no"}`,
  ].join("\n"), 2000);
}

export function buildHermesNousRuntimeHealth(params: {
  heartbeat: LocalWorkerHeartbeatRow | null;
  codexAvailable: boolean;
  hermesAgentAvailable: boolean;
  hermesAgentAuthConfigured: boolean;
  hermesAgentModelConfigured: boolean;
}): HermesNousRuntimeHealth {
  const selectedModelProvider = params.hermesAgentModelConfigured
    ? "Selected on worker heartbeat; exact provider/model is not exposed by the local worker."
    : "Missing on worker heartbeat.";
  const supportedExecutionProfiles = [
    params.hermesAgentAvailable ? "hermes_agent" : null,
    "local_worker",
    params.codexAvailable ? "codex_fallback" : null,
  ].filter((item): item is string => Boolean(item));
  const runtime: Omit<HermesNousRuntimeHealth, "diagnostic"> = {
    installed: params.hermesAgentAvailable,
    installPath: safePathLabel(params.heartbeat?.hermesAgentPath),
    version: params.heartbeat?.hermesAgentVersion ?? null,
    authState: params.heartbeat ? params.hermesAgentAuthConfigured ? "configured" : "missing" : "unknown",
    selectedModelProvider,
    workerState: hermesWorkerState(params.heartbeat),
    lastSuccessfulRun: params.heartbeat?.lastHermesAgentRun ?? null,
    lastFailure: redactExecutionText(params.heartbeat?.lastHermesAgentError ?? null, 500) || null,
    currentActiveRun: params.heartbeat?.currentTask ?? null,
    supportedExecutionProfiles,
    codexFallbackAvailable: params.codexAvailable,
  };
  return { ...runtime, diagnostic: hermesRuntimeDiagnostic(runtime) };
}

function boolish(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
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
    logHealth(
      "api-providers",
      aggregateProviderSeverity(snapshot.apiProviders),
      snapshot.apiProviders.map((provider) => `${provider.provider}: ${provider.status}`).join(" | ")
    ),
  ]);
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s,;]+)/gi, "$1=[redacted]")
    .slice(0, 280);
}

/** Remove copy/paste artifacts that are invalid in HTTP header values. */
export function cleanProviderCredential(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\uFEFF\u200B-\u200D]/g, "")
    .trim()
    .replace(/^[\u0000-\u0020\u007F-\u009F]+|[\u0000-\u0020\u007F-\u009F]+$/g, "");
}

const SANITIZED_PROVIDER_ENV = new Set([
  "GITHUB_TOKEN", "VERCEL_TOKEN", "FIRECRAWL_API_KEY", "SERPAPI_API_KEY",
  "SAKANA_API_KEY", "TELEGRAM_BOT_TOKEN", "AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
]);

function providerCredential(name: string): string {
  return cleanProviderCredential(process.env[name]);
}

function providerEnvConfigured(name: string): boolean {
  return SANITIZED_PROVIDER_ENV.has(name) ? Boolean(providerCredential(name)) : hasEnv(name);
}

export function apiProviderSeverity(provider: Pick<ApiProviderHealth, "provider" | "status">): HealthSeverity {
  if (provider.status === "working" || provider.status === "configured_untested") return "healthy";
  if (provider.status === "missing") return "warning";
  return "failure";
}

function aggregateProviderSeverity(providers: ApiProviderHealth[]): HealthSeverity {
  const severities = providers.map(apiProviderSeverity);
  return severities.includes("failure") ? "failure" : severities.includes("warning") ? "warning" : "healthy";
}

function providerRow(params: {
  provider: string;
  env: string[];
  runs: AgentRunRow[];
  component: string;
  status?: ApiProviderStatus;
  safeError?: string | null;
  configured?: boolean;
  family?: ProviderFamily;
  role?: ProviderRole;
  roleLabel?: string;
  selectedModel?: string;
  environment?: ProviderEnvironment;
  routePreview?: string;
  council?: boolean;
  testable?: boolean;
}): ApiProviderHealth {
  const configured = params.configured ?? params.env.every(providerEnvConfigured);
  const latest = latestHealthLog(params.runs, params.component);
  let status = params.status;
  let safeError = params.safeError ?? null;
  if (!status && latest?.outputSummary) {
    const parsed = latest.outputSummary.match(/status=([a-z_]+)/i)?.[1] as ApiProviderStatus | undefined;
    status = parsed ?? undefined;
    safeError = latest.outputSummary.match(/message=(.+)$/)?.[1] ?? null;
  }
  return {
    provider: params.provider,
    family: params.family,
    role: params.role,
    roleLabel: params.roleLabel,
    selectedModel: params.selectedModel,
    environment: params.environment,
    routePreview: params.routePreview,
    council: params.council,
    testable: params.testable,
    configured,
    requiredEnvVars: params.env,
    source: runtimeSource(),
    lastTested: iso(latest?.createdAt),
    status: status ?? (configured ? "configured_untested" : "missing"),
    safeError: safeError ?? (configured ? null : `Missing ${params.env.filter((key) => !providerEnvConfigured(key)).join(", ")}`),
  };
}

async function testJsonEndpoint(url: string, init: RequestInit, authErrorLabel = "provider returned authentication error", authStatuses = [401, 403]): Promise<{ status: ApiProviderStatus; safeError: string | null }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (authStatuses.includes(res.status)) return { status: "invalid", safeError: authErrorLabel };
    if (!res.ok) return { status: "error", safeError: `Provider returned HTTP ${res.status}.` };
    return { status: "working", safeError: null };
  } catch (error) {
    return { status: "error", safeError: safeProviderError(error) };
  }
}

function councilProviderRows(runs: AgentRunRow[]): ApiProviderHealth[] {
  return MODEL_PROVIDER_REGISTRY.map((entry) => {
    const configured = entry.env.every(providerEnvConfigured);
    let status: ApiProviderStatus | undefined;
    let safeError: string | null | undefined;
    if (entry.family === "ollama") {
      status = configured ? "configured_untested" : "missing";
      safeError = configured
        ? "Deferred local runtime. Browser and Vercel do not test Ollama directly."
        : `Missing ${entry.env.filter((key) => !providerEnvConfigured(key)).join(", ")}`;
    }
    return providerRow({
      provider: entry.provider,
      env: entry.env,
      runs,
      component: providerComponent(entry.provider),
      configured,
      status,
      safeError,
      family: entry.family,
      role: entry.role,
      roleLabel: entry.roleLabel,
      selectedModel: selectedProviderModel(entry),
      environment: entry.environment,
      routePreview: entry.routePreview,
      council: entry.council,
      testable: entry.testable,
    });
  });
}

function safeDeepSeekBaseUrl(): string {
  const raw = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return "https://api.deepseek.com";
  }
}

export async function getApiProviderHealth(userId: string, runs: AgentRunRow[], test = false, options: { onlyModelProviders?: boolean } = {}): Promise<ApiProviderHealth[]> {
  const accounts = await prisma.googleAccount.findMany({ where: { userId } }).catch(() => []);
  const source = runtimeSource();
  const rows: ApiProviderHealth[] = [
    ...councilProviderRows(runs),
    providerRow({ provider: "Sakana / Fugu", env: ["SAKANA_API_KEY"], runs, component: providerComponent("Sakana / Fugu") }),
    providerRow({ provider: "Firecrawl Web Search", env: ["FIRECRAWL_API_KEY"], runs, component: providerComponent("Firecrawl Web Search") }),
    providerRow({ provider: "SerpAPI Google Flights", env: ["SERPAPI_API_KEY"], runs, component: providerComponent("SerpAPI Google Flights") }),
    providerRow({ provider: "Gmail", env: [], runs, component: providerComponent("Gmail"), configured: accounts.some((account) => /gmail|mail\.google/i.test(account.scopes)) }),
    providerRow({ provider: "Calendar", env: [], runs, component: providerComponent("Calendar"), configured: accounts.some((account) => /calendar/i.test(account.scopes)) }),
    providerRow({ provider: "Telegram", env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID"], runs, component: providerComponent("Telegram") }),
    providerRow({ provider: "GitHub", env: ["GITHUB_TOKEN"], runs, component: providerComponent("GitHub") }),
    providerRow({ provider: "Vercel", env: ["VERCEL_TOKEN"], runs, component: providerComponent("Vercel") }),
    providerRow({ provider: "Turso", env: ["TURSO_DATABASE_URL"], runs, component: providerComponent("Turso") }),
  ].map((row) => ({ ...row, source }));

  if (!test) return rows;

  const tested: ApiProviderHealth[] = [];
  for (const row of rows) {
    let result: { status: ApiProviderStatus; safeError: string | null };
    if (options.onlyModelProviders && !row.family) {
      tested.push(row);
      continue;
    } else if (!row.configured) {
      result = { status: "missing", safeError: `Missing ${row.requiredEnvVars.filter((key) => !providerEnvConfigured(key)).join(", ") || "connected account"}` };
    } else if (row.family === "openai") {
      result = await testJsonEndpoint("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${cleanProviderCredential(process.env.OPENAI_API_KEY)}` } });
    } else if (row.family === "anthropic") {
      result = await testJsonEndpoint("https://api.anthropic.com/v1/models", { headers: { "x-api-key": cleanProviderCredential(process.env.ANTHROPIC_API_KEY), "anthropic-version": "2023-06-01" } });
    } else if (row.family === "deepseek") {
      result = await testJsonEndpoint(`${safeDeepSeekBaseUrl()}/models`, { headers: { Authorization: `Bearer ${cleanProviderCredential(process.env.DEEPSEEK_API_KEY)}` } });
    } else if (row.family === "gemini") {
      result = await testJsonEndpoint("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": cleanProviderCredential(process.env.GEMINI_API_KEY) } });
    } else if (row.family === "ollama") {
      result = { status: row.configured ? "configured_untested" : "missing", safeError: row.configured ? "Deferred local runtime. Test through the Hermes local worker in the next phase." : row.safeError };
    } else if (row.provider === "SerpAPI Google Flights") {
      result = await testJsonEndpoint(`https://serpapi.com/account?api_key=${encodeURIComponent(providerCredential("SERPAPI_API_KEY"))}`, {}, "Invalid key or provider rejected request", [400, 401, 403]);
    } else if (row.provider === "Telegram") {
      result = await testJsonEndpoint(`https://api.telegram.org/bot${providerCredential("TELEGRAM_BOT_TOKEN")}/getMe`, {});
    } else if (row.provider === "GitHub") {
      result = await testJsonEndpoint("https://api.github.com/user", { headers: { Authorization: `Bearer ${providerCredential("GITHUB_TOKEN")}`, "User-Agent": "Hermes-Health-Center" } });
    } else if (row.provider === "Vercel") {
      result = await testJsonEndpoint("https://api.vercel.com/v2/user", { headers: { Authorization: `Bearer ${providerCredential("VERCEL_TOKEN")}` } });
    } else if (row.provider === "Turso") {
      try {
        await prisma.$queryRawUnsafe("SELECT 1");
        result = { status: "working", safeError: null };
      } catch (error) {
        result = { status: "error", safeError: safeProviderError(error) };
      }
    } else {
      result = { status: "configured_untested", safeError: "Configured but no safe minimal test endpoint is wired yet." };
    }

    const statusForLog = apiProviderSeverity({ provider: row.provider, status: result.status });
    await prisma.agentRun.create({
      data: {
        agentName: "health-center",
        inputSummary: `api_provider_test component=${providerComponent(row.provider)}`,
        outputSummary: `status=${result.status} message=${result.safeError ?? "ok"}`,
        modelProvider: "internal",
        status: statusForLog,
      },
    }).catch(() => undefined);

    tested.push({ ...row, status: result.status, safeError: result.safeError, lastTested: new Date().toISOString() });
  }
  return tested;
}

export async function getHealthCenterSnapshot(userId: string): Promise<HealthCenterSnapshot> {
  const [accounts, runs, queueTasks, workerHeartbeats, trackedCount, jobLeadCount, codexStatus, recentApprovals] = await Promise.all([
    prisma.googleAccount.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }),
    prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 250 }),
    prisma.$queryRawUnsafe<QueueHealthRow[]>(`SELECT status, assigned_executor FROM AgentTask WHERE userId = ? ORDER BY updatedAt DESC LIMIT 80`, userId).catch(() => []),
    prisma.$queryRawUnsafe<LocalWorkerHeartbeatRow[]>(`SELECT * FROM LocalWorkerHeartbeat ORDER BY lastHeartbeat DESC LIMIT 1`).catch(() => []),
    prisma.trackedApplication.count({ where: { userId } }).catch(() => 0),
    prisma.jobLead.count({ where: { userId } }).catch(() => 0),
    getCodexCliStatus().catch(() => ({ installed: false, available: false, version: null, message: "Codex CLI status unavailable." })),
    prisma.approvalAction.findMany({ where: { userId, status: "pending" }, take: 25 }).catch(() => []),
  ]);

  const gmailSync = latestRun(runs, ["gmail_sync_completed", "gmail", "email-watcher"]);
  // "Connected" means we can obtain a valid token: a refresh token exists (the
  // access token rotating hourly is normal OAuth, not breakage) or the current
  // access token is still live. Measuring raw expiresAt scored working
  // accounts 0 every hour — see fix-and-harden brief 7.2.
  const canObtainToken = (account: { refreshToken: string | null; expiresAt: Date }) =>
    Boolean(account.refreshToken?.trim()) || account.expiresAt.getTime() > Date.now();
  const linkedGoogleRows: HealthAccount[] = accounts.map((account, index) => {
    const connected = canObtainToken(account);
    const gmailScope = hasGmailScope(account.scopes);
    const calendarScope = hasCalendarScope(account.scopes);
    const warnings = [
      !connected ? "reconnect required (no refresh token, access token expired)" : null,
      connected && !account.refreshToken?.trim() ? "no refresh token — will disconnect when the access token expires" : null,
      !gmailScope ? "gmail scope missing" : null,
      !calendarScope ? "calendar scope missing" : null,
    ].filter((item): item is string => Boolean(item));
    const row: HealthAccount = {
      name: `Google Account ${index + 1}`,
      email: account.email,
      label: account.label,
      gmailScope,
      calendarScope,
      tokenExpiresAt: account.expiresAt.toISOString(),
      connected,
      lastSuccessfulSync: gmailSync && !/fail|error/i.test(gmailSync.status) ? iso(gmailSync.createdAt) : null,
      lastError: !connected ? "OAuth reconnect required (no valid refresh token)" : warnings.length ? warnings.join(", ") : null,
      reconnectRequired: !connected || !gmailScope || !calendarScope,
      warnings,
      score: 0,
    };
    row.score = accountHealthScore(row);
    return row;
  });

  const accountRows: HealthAccount[] = linkedGoogleRows.length > 0 ? linkedGoogleRows : [{
    name: "Google Account",
    email: null,
    label: null,
    gmailScope: false,
    calendarScope: false,
    tokenExpiresAt: null,
    connected: false,
    lastSuccessfulSync: null,
    lastError: "No linked Google account",
    reconnectRequired: true,
    warnings: ["account disconnected"],
    score: 0,
  }];

  const calendarAccount = accounts.find((account) => /calendar/i.test(account.scopes));
  const gmailAccounts = accounts.filter((account) => hasGmailScope(account.scopes));
  const hasUsableGmail = gmailAccounts.some(canObtainToken);
  const hasUsableCalendar = Boolean(calendarAccount && canObtainToken(calendarAccount));
  const calendarExpired = calendarAccount ? !canObtainToken(calendarAccount) : false;
  const calendarRow: HealthAccount = {
    name: "Google Calendar",
    email: calendarAccount?.email ?? null,
    label: calendarAccount?.label ?? null,
    gmailScope: calendarAccount ? hasGmailScope(calendarAccount.scopes) : false,
    calendarScope: Boolean(calendarAccount),
    tokenExpiresAt: calendarAccount?.expiresAt.toISOString() ?? null,
    connected: hasUsableCalendar,
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
  const latestLocalWorker = workerHeartbeats[0] ?? null;
  const gitAvailable = boolish(latestLocalWorker?.gitAvailable);
  const codexAvailable = boolish(latestLocalWorker?.codexAvailable);
  const hermesAgentAvailable = boolish(latestLocalWorker?.hermesAgentAvailable);
  const hermesAgentAuthConfigured = boolish(latestLocalWorker?.hermesAgentAuthConfigured);
  const hermesAgentModelConfigured = boolish(latestLocalWorker?.hermesAgentModelConfigured);
  const hermesAgentReady = hermesAgentAvailable && hermesAgentAuthConfigured && hermesAgentModelConfigured;
  const hermesNousRuntime = buildHermesNousRuntimeHealth({
    heartbeat: latestLocalWorker,
    codexAvailable,
    hermesAgentAvailable,
    hermesAgentAuthConfigured,
    hermesAgentModelConfigured,
  });
  const executorRows: ExecutorHealthRow[] = [
    { name: "Hermes", status: executorStatus(latestRun(runs, ["hermes"]), false, true), lastRun: iso(latestRun(runs, ["hermes"])?.createdAt), lastError: latestRun(runs, ["hermes"])?.status === "failed" ? latestRun(runs, ["hermes"])?.outputSummary ?? null : null },
    { name: "Builder", status: executorStatus(latestRun(runs, ["local_build", "hermes-local-builder"]), busyExecutors.has("hermes-local-builder"), true), lastRun: iso(latestRun(runs, ["local_build", "hermes-local-builder"])?.createdAt), lastError: latestRun(runs, ["local_build", "hermes-local-builder"])?.status === "failed" ? latestRun(runs, ["local_build", "hermes-local-builder"])?.outputSummary ?? null : null },
    {
      name: "Local Worker",
      status: localWorkerStatus(latestLocalWorker),
      lastRun: latestLocalWorker?.lastHeartbeat ?? null,
      lastError: latestLocalWorker?.lastError ?? (latestLocalWorker ? null : "No local worker heartbeat recorded"),
      workerId: latestLocalWorker?.workerId ?? null,
      machineName: latestLocalWorker?.machineName ?? null,
      rootPath: latestLocalWorker?.rootPath ?? null,
      nodeVersion: latestLocalWorker?.nodeVersion ?? null,
      npmVersion: latestLocalWorker?.npmVersion ?? null,
      gitAvailable,
      codexAvailable,
      currentTask: latestLocalWorker?.currentTask ?? null,
      workerApiTarget: latestLocalWorker?.workerApiTarget ?? null,
      lastFetchError: latestLocalWorker?.lastFetchError ?? null,
      capabilities: latestLocalWorker ? [
        `Node ${latestLocalWorker.nodeVersion ?? "unknown"}`,
        `npm ${latestLocalWorker.npmVersion ?? "unknown"}`,
        `Git ${gitAvailable ? "available" : "missing"}`,
        `Codex ${codexAvailable ? "available" : "missing"}`,
        `Hermes Agent ${hermesAgentAvailable ? latestLocalWorker.hermesAgentVersion ?? "available" : "missing"}`,
      ] : [],
    },
    {
      name: "Hermes Agent",
      status: busyExecutors.has("hermes_agent") ? "Busy" : hermesAgentReady ? "Ready" : "Offline",
      lastRun: latestLocalWorker?.lastHermesAgentRun ?? null,
      lastError: latestLocalWorker?.lastHermesAgentError ?? (latestLocalWorker && !hermesAgentReady ? "Hermes Agent needs Nous OAuth and a selected model/provider" : null),
      machineName: latestLocalWorker?.machineName ?? null,
      capabilities: latestLocalWorker ? [
        `Executable ${safePathLabel(latestLocalWorker.hermesAgentPath) ?? "missing"}`,
        `Version ${latestLocalWorker.hermesAgentVersion ?? "unknown"}`,
        `Nous OAuth ${hermesAgentAuthConfigured ? "configured" : "missing"}`,
        `Model/provider ${hermesAgentModelConfigured ? "selected" : "missing"}`,
      ] : [],
    },
    { name: "Codex Executor", status: executorStatus(latestRun(runs, ["codex_cli"]), busyExecutors.has("codex_cli"), codexStatus.available), lastRun: iso(latestRun(runs, ["codex_cli"])?.createdAt), lastError: codexStatus.available ? latestRun(runs, ["codex_cli"])?.status === "failed" ? latestRun(runs, ["codex_cli"])?.outputSummary ?? null : null : codexStatus.message },
    { name: "Fugu Critic", status: executorStatus(latestRun(runs, ["fugu"]), false, hasEnv("SAKANA_API_KEY")), lastRun: iso(latestRun(runs, ["fugu"])?.createdAt), lastError: hasEnv("SAKANA_API_KEY") ? null : "SAKANA_API_KEY is not configured" },
    { name: "Job Tracker", status: executorStatus(latestRun(runs, ["job-tracker", "job-scout"]), false, true), lastRun: iso(latestRun(runs, ["job-tracker", "job-scout"])?.createdAt), lastError: latestRun(runs, ["job-tracker", "job-scout"])?.status === "failed" ? latestRun(runs, ["job-tracker", "job-scout"])?.outputSummary ?? null : null },
    { name: "Email Intelligence", status: executorStatus(latestRun(runs, ["email-watcher", "thread-watcher"]), false, hasUsableGmail), lastRun: iso(latestRun(runs, ["email-watcher", "thread-watcher"])?.createdAt), lastError: hasUsableGmail ? null : "No connected Google account with Gmail scope" },
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
      status: hasUsableGmail ? "healthy" : "warning",
    },
    {
      name: "Mission Control Alerts",
      lastSent: iso(latestRun(runs, ["health-center", "approval", "alert"])?.createdAt),
      lastFailed: null,
      pendingNotifications: recentApprovals.length,
      status: recentApprovals.length > 0 ? "warning" : "healthy",
    },
  ];

  const apiProviders = await getApiProviderHealth(userId, runs, false);

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
    ...executorRows.filter((row) => row.status === "Offline" && row.lastError && !(row.name === "Codex Executor" && hermesAgentReady)),
    ...notificationRows.filter((row) => row.status === "failure"),
    ...apiProviders.filter((row) => apiProviderSeverity(row) === "failure"),
  ].length;
  const warnings = [
    ...accountRows.filter((row) => row.warnings.length > 0),
    ...scheduledJobs.filter((job) => job.status === "Delayed" || job.status === "Never Ran"),
    ...executorRows.filter((row) => row.status === "Stale" || (row.status === "Offline" && row.name === "Codex Executor" && hermesAgentReady)),
    ...notificationRows.filter((row) => row.status === "warning"),
    ...apiProviders.filter((row) => apiProviderSeverity(row) === "warning"),
  ].length;
  const accountScore = Math.round(accountRows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, accountRows.length));
  const jobScore = Math.round((scheduledJobs.filter((job) => job.status === "Healthy").length / Math.max(1, scheduledJobs.length)) * 100);
  const executorScore = Math.round((executorRows.filter((row) => row.status !== "Offline" || (row.name === "Codex Executor" && hermesAgentReady)).length / Math.max(1, executorRows.length)) * 100);
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
    hermesNousRuntime,
    notifications: notificationRows,
    apiProviders,
    logs: healthLogs,
  };
}
