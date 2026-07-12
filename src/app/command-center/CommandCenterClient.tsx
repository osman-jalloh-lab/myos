"use client";

import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import BuilderOffice from "./BuilderOffice";
import LiveBuildConsole from "./LiveBuildConsole";
import AgentRoster from "@/components/AgentRoster";
import CouncilChatPanel from "@/components/CouncilChatPanel";
import HermesNousChatPanel from "@/components/HermesNousChatPanel";
import { agentColor, CHAT_ROSTER_AGENTS, COUNCIL_REVIEWER_AGENTS } from "@/lib/agent-roster";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  assignedAgent: string | null;
  nextStep: string | null;
}

interface QaItem {
  key: string;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}

interface Project {
  id: string;
  projectName: string;
  description: string | null;
  route: string | null;
  localFolderPath: string | null;
  buildLog: string | null;
  buildError: string | null;
  localDevUrl: string | null;
  localDevPid: number | null;
  previewStatus: "online" | "offline" | "stale" | null;
  researchBrief: string | null;
  designReview: string | null;
  polishReview: string | null;
  designScore: number | null;
  qaStatus: string | null;
  qaChecklist: QaItem[] | null;
  status: string;
  latestInstruction: string | null;
  currentTask: string | null;
  assignedAgent: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts: { pending: number; in_progress: number; done: number; total: number };
  tasks: ProjectTask[];
}

interface Build {
  id: string;
  title: string;
  status: string;
  operationType: string;
  riskLevel: string;
  approvalStatus: string | null;
  approvalRequired: boolean;
  resultSummary: string | null;
  implementationSummary: string | null;
  branchName: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  deploymentUrl: string | null;
  deployStatus: string | null;
  sanitizedError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deployStartedAt: string | null;
  deployCompletedAt: string | null;
  createdAt: string;
}

interface ApprovalAction {
  id: string;
  actionType: string;
  payload: unknown;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  executionNote?: string;
}

interface AgentRun {
  id: string;
  agentName: string;
  inputSummary: string | null;
  outputSummary: string | null;
  modelProvider: string | null;
  status: string;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: string | null;
  createdAt: string;
}

interface ExecutionQueueTask {
  id: string;
  title: string;
  description: string;
  status: "queued" | "planning" | "executing" | "qa_pending" | "qa_passed" | "waiting_approval" | "completed" | "failed" | "cancelled";
  priority: string;
  assignedExecutor: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  result: string | null;
  logs: string[];
}

interface ExecutorHealth {
  executor: string;
  active: number;
  failed: number;
  completed: number;
  lastUpdated: string;
}

interface ExecutionQueueData {
  tasks: ExecutionQueueTask[];
  counts: Record<string, number>;
  executorHealth: ExecutorHealth[];
  lastUpdated: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel?: string;
  createdAt: string;
  quickActions?: ChatQuickAction[];
}

interface ExecutionTraceEvent {
  id: string;
  runId: string;
  phase: string;
  severity: "info" | "warning" | "error";
  message: string;
  source: string;
  safeDetails?: Record<string, unknown>;
  createdAt: string;
}

interface ExecutionRun {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  parentRunId: string | null;
  executor: string;
  currentPhase: string;
  currentActivity: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  lastMeaningfulEventAt: string;
  completedAt: string | null;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "stalled";
  lastSafeError: string | null;
  workerId: string | null;
  localFolderPath: string | null;
  fallbackReason: string | null;
  cancellationRequestedAt: string | null;
  elapsedMs: number;
  heartbeatAgeMs: number;
  meaningfulEventAgeMs: number;
  stuckReason: string | null;
  latestEvent: ExecutionTraceEvent | null;
}

interface ExecutionRunsData {
  runs: ExecutionRun[];
  lastUpdated: string;
}

interface ChatQuickAction {
  id: string;
  label: string;
  value: string;
  description?: string;
}

interface MemoryOfficeData {
  confirmedFacts?: Array<{ id: string; fact: string; source: string | null; date: string; confidence: number; whereUsed: string[]; pinned: boolean; archived: boolean }>;
  inferredFacts?: Array<{ id: string; fact: string; source: string | null; date: string; confidence: number; whereUsed: string[]; status: string }>;
  projectDecisionItems?: Array<{ id: string; projectName: string; status: string; decision: string; source: string; date: string; confidence: number; whereUsed: string[] }>;
  operationalLessons?: Array<{ id: string; lesson: string; source: string; date: string; confidence: number; whereUsed: string[] }>;
  recentMemoryUse?: Array<{ id: string; runId: string | null; agentName: string | null; taskType: string | null; query: string; retrieved: Array<{ id: string; fact: string; source: string | null; confidence: number }>; createdAt: string }>;
  memories: Array<{ id: string; fact: string; source: string | null; createdAt: string; approvedAt: string | null }>;
  projectDecisions: Array<{ id: string; projectName: string; status: string; decision: string; updatedAt: string }>;
  buildLessons: Array<{ id: string; status: string; summary: string; createdAt: string }>;
  researchBriefs: Array<{ id: string; projectName: string; brief: string; updatedAt: string }>;
  failedBuildFixes: Array<{ id: string; projectName: string; error: string; log: string; updatedAt: string }>;
  userPreferences: Array<{ id: string; fact: string; source: string | null; createdAt: string }>;
  lastUpdated: string;
}

interface MemoryContextDebugData {
  activeSession: { id: string | null; chatId: string | null; userId: string | null; lastUpdated: string | null } | null;
  activeIntent: string | null;
  activeTask: string | null;
  activeProjectId: string | null;
  rememberedEntities: Record<string, unknown>;
  toolHealth: Array<{ tool: string; status: string; reason: string | null; lastChecked: string }>;
  recentFailures: Array<{ tool: string; reason: string; timestamp: string }>;
  pendingApprovals: Array<{ id: string; actionType: string; createdAt: string }>;
  last20MessagesLoaded: Array<{ id: string; role: string; content: string; channel: string; targetAgent: string | null; createdAt: string }>;
  lastUpdated: string;
}

interface AgentBusEnvelope {
  id: string;
  fromAgent: string;
  toAgent: string | null;
  envelopeType: string;
  payload: unknown;
  status: "pending" | "consumed" | "expired";
  correlationId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface AgentBusData {
  envelopes: AgentBusEnvelope[];
  counts: Record<string, number>;
  lastUpdated: string;
}

interface ProjectFlowNode {
  id: string;
  label: string;
  kind: "project" | "plan" | "task" | "agent" | "wakeup" | "capability_gap" | "approval" | "run" | "artifact";
  status?: string | null;
  agentKey?: string | null;
}

interface ProjectFlowEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface ProjectFlowData {
  project: { id: string; name: string; status: string; phase: string; assignedAgent: string | null; latestPlanId: string | null; updatedAt: string | null };
  plan: { id: string; revision: number; status: string; acceptedAt: string | null } | null;
  nodes: ProjectFlowNode[];
  edges: ProjectFlowEdge[];
  tasks: Array<{ id: string; title: string; status: string; priority: string; assignedAgent: string | null; responsibleAgent: string | null; acceptanceCriteria: string | null; outputContract: string | null; blockedReason: string | null; completedAt: string | null; updatedAt: string | null }>;
  wakeups: Array<{ id: string; projectTaskId: string | null; agentKey: string; source: string; reason: string; status: string; coalescedCount: number; requestedAt: string | null }>;
  capabilityGaps: Array<{ id: string; projectTaskId: string | null; capabilityName: string; capabilityType: string; status: string; assignedAgent: string | null; blockedReason: string | null; createdAt: string | null }>;
  approvals: Array<{ id: string; actionType: string; status: string; createdAt: string | null; resolvedAt: string | null }>;
  runs: Array<{ id: string; taskId: string | null; executor: string; status: string; currentPhase: string; currentActivity: string | null; startedAt: string | null; completedAt: string | null }>;
  artifacts: Array<{ id: string; kind: string; label: string; uri?: string }>;
  timeline: Array<{ kind: string; title: string; at: string | null; details: Record<string, unknown> }>;
}

interface SkillView {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  ownerAgents: string[];
  tags: string[];
  triggerExamples: string[];
  requiredCapabilities: string[];
  safetyClass: "read_only" | "approval_required" | "local_execution";
  estimatedCostSaving: "none" | "low" | "medium" | "high";
  lastUsedAt: string | null;
  usageCount: number;
  source: "built_in" | "installed" | "scouted" | "user";
  validationStatus: "valid" | "missing_metadata" | "invalid";
  category: string;
  dateAdded: string | null;
  validationWarnings: string[];
  problemSolved: string;
  instructionFile: string | null;
  instructionPreview: string | null;
  purpose: string;
  whenToUse: string[];
  whenNotToUse: string[];
  strongSignals: string[];
  weakSignals: string[];
  negativeSignals: string[];
  requiredContext: string[];
  missingContextQuestions: string[];
  outputContract: { format: string; mustInclude: string[]; mustAvoid: string[]; tone?: string };
  safetyRules: string[];
  approvalRequiredFor: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  evaluationPrompts: Array<{ input: string; shouldMatch: boolean; minimumScore?: number; expectedSkill?: string; reason: string }>;
  version: string;
  lastReviewedAt: string | null;
  skillQualityScore: number;
  skillQualityBand: "Excellent" | "Strong" | "Usable" | "Weak" | "Needs upgrade";
  qualityWarnings: string[];
}

interface SkillRegistryData {
  refreshed: boolean;
  lastUpdated: string;
  personalSkills: Array<{ id: string; present: boolean }>;
  quality?: {
    average: number;
    personalAverage: number;
    personalBelow85: string[];
  };
}

interface SkillTestResult {
  matched: boolean;
  score: number;
  reason: string;
  matchedSignals?: string[];
  negativeMatches?: string[];
  missingContextQuestions?: string[];
  skillQualityScore?: number;
  skillQualityBand?: SkillView["skillQualityBand"];
}

interface SkillCandidate {
  name: string;
  source: string;
  sourceUrl: string;
  repository: string;
  path: string;
  category: string;
  description: string;
  whyItHelps: string;
  installCommand: string;
  riskyFiles: string[];
  approvalRequired: boolean;
  status: string;
  testResult: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  createdAt: string;
}

interface SkillScoutCandidate {
  name: string;
  sourceRepo: string;
  sourcePath: string;
  sourceUrl: string;
  category: string;
  summary: string;
  whyItHelpsParawi: string;
  overlapWithExistingSystem: string;
  implementationDifficulty: string;
  riskLevel: "low" | "medium" | "high";
  recommendedAction: string;
  scores: { benefit: number; risk: number; effort: number; priority: "high" | "medium" | "low" };
  expectedFilesChanged: string[];
  rollbackPlan: string;
}

interface SkillScoutResult {
  repoUrl: string;
  repo: {
    fullName: string;
    description: string | null;
    defaultBranch: string;
    stars: number;
    language: string | null;
    topics: string[];
  };
  inspected: { treeItems: number; candidateFiles: number; scriptsRun: false; filesImported: false };
  candidates: SkillScoutCandidate[];
  approvals: Array<{ id: string; candidateName: string; actionType: string; status: string }>;
  safetyNotes: string[];
}

type HealthSeverity = "healthy" | "warning" | "failure";
type AgentOffice = "hermes" | "athena" | "builder" | "iris" | "fugu";

interface HealthCenterData {
  overall: { status: HealthSeverity; score: number; message: string; lastChecked: string };
  accounts: Array<{ name: string; connected: boolean; email?: string | null; label?: string | null; gmailScope?: boolean; calendarScope?: boolean; tokenExpiresAt?: string | null; lastSuccessfulSync: string | null; lastError: string | null; reconnectRequired: boolean; warnings: string[]; score: number }>;
  scheduledJobs: Array<{ name: string; key: string; enabled: boolean; lastRun: string | null; nextRun: string | null; lastResult: string | null; runtime: string | null; successCount: number; failureCount: number; status: "Healthy" | "Delayed" | "Failed" | "Never Ran" | "Disabled" }>;
  executors: Array<{ name: string; status: "Ready" | "Online" | "Offline" | "Stale" | "Busy" | "Unknown"; lastRun: string | null; lastError: string | null; workerId?: string | null; machineName?: string | null; rootPath?: string | null; nodeVersion?: string | null; npmVersion?: string | null; gitAvailable?: boolean | null; codexAvailable?: boolean | null; currentTask?: string | null; workerApiTarget?: string | null; lastFetchError?: string | null; capabilities?: string[] }>;
  hermesNousRuntime?: {
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
  notifications: Array<{ name: string; lastSent: string | null; lastFailed: string | null; pendingNotifications: number; status: HealthSeverity }>;
  apiProviders: Array<{
    provider: string;
    family?: "openai" | "anthropic" | "deepseek" | "gemini" | "ollama" | "groq";
    roleLabel?: string;
    selectedModel?: string;
    environment?: "Local" | "Vercel" | "Both";
    routePreview?: string;
    council?: boolean;
    testable?: boolean;
    configured: boolean;
    requiredEnvVars: string[];
    source: "local env" | "Vercel/runtime";
    lastTested: string | null;
    status: "working" | "missing" | "invalid" | "error" | "configured_untested";
    safeError: string | null;
  }>;
  logs: Array<{ timestamp: string; component: string; status: HealthSeverity; message: string }>;
  actionResult?: { ok: boolean; message: string };
}

interface AccountsHealthData {
  currentSession: { userId: string; email: string | null; name: string | null };
  accounts: Array<{
    id: string;
    email: string;
    label: string;
    isDefault: boolean;
    scopes: string;
    gmailScope: boolean;
    calendarScope: boolean;
    createdAt: string;
    tokenExpiresAt: string;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
    lastError: string | null;
    health: "connected" | "expiring_soon" | "disconnected" | "unknown";
    reconnectRequired: boolean;
  }>;
  results?: Array<{ accountId: string; status: string; email?: string; error?: string | null }>;
}

type Tab = "overview" | "health" | "agents" | "memory" | "skills" | "projects" | "builds" | "runs" | "bus" | "logs" | "chat";

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function relativeTime(iso: string): string {
  const target = new Date(iso).getTime();
  const diff = target - Date.now();
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const label = m < 1 ? "now" : m < 60 ? `${m}m` : Math.floor(m / 60) < 24 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
  if (label === "now") return "now";
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

function statusColor(status: string): string {
  switch (status) {
    case "healthy": case "Healthy": case "Ready": case "Online": return "#34D399";
    case "warning": case "Delayed": case "Never Ran": case "stalled": return "#FBBF24";
    case "failure": case "Failed": case "Offline": return "#F87171";
    case "Busy": return "#A78BFA";
    case "active": case "completed": case "done": case "deployed": case "qa_passed": case "Ready to Build": case "Brief Ready": case "Dev Server Running": return "#34D399";
    case "planning": case "approved": case "queued": case "qa_pending": return "#60A5FA";
    case "in_progress": case "building": case "running": case "executing": case "qa_running": case "implementation_running": case "validation_running": case "Researching": case "Generating": case "Installing": case "Building": return "#A78BFA";
    case "waiting_approval": return "#FBBF24";
    case "blocked": case "failed": case "qa_failed": case "Build Failed": return "#F87171";
    case "cancelled": return "#94A3B8";
    case "Dev Server Stopped": return "#60A5FA";
    default: return "#94A3B8";
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function qualityColor(score: number): string {
  if (score >= 90) return "#34D399";
  if (score >= 75) return "#60A5FA";
  if (score >= 60) return "#FBBF24";
  return "#F87171";
}

function localPreviewPort(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).port || null;
  } catch {
    return url.match(/:(\d+)(?:\/|$)/)?.[1] ?? null;
  }
}

function localDevServerStatus(project: Pick<Project, "status" | "localDevUrl" | "localDevPid">): string {
  if (project.status === "Preview Stale") return "Preview Stale";
  if (project.status === "Dev Server Running") return "Dev Server Running";
  if (project.status === "Dev Server Stopped") return "Dev Server Stopped";
  return "Not Started";
}

function manualDevCommand(folder: string | null | undefined): string | null {
  if (!folder) return null;
  return `cd "${folder}"\nnpm run dev`;
}

function LocalPreviewDetails({ project, compact = false }: { project: Project; compact?: boolean }) {
  const [showLocalhostNote, setShowLocalhostNote] = useState(false);
  const port = localPreviewPort(project.localDevUrl);
  const devStatus = localDevServerStatus(project);
  const manualCommand = manualDevCommand(project.localFolderPath);

  useEffect(() => {
    setShowLocalhostNote(window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1");
  }, []);

  return (
    <div style={{ marginBottom: compact ? 0 : 12, padding: compact ? "10px 12px" : "12px 14px", background: "rgba(52,211,153,0.07)", border: "1px solid rgba(52,211,153,0.22)", borderRadius: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#34D399", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Local preview</div>
        <span style={badgeStyle(statusColor(devStatus))}>{devStatus}</span>
      </div>
      <div style={{ display: "grid", gap: 6, color: "#94A3B8", fontSize: 12 }}>
        <span>Project: <strong style={{ color: "#F1F4FB" }}>{project.projectName}</strong></span>
        <span>Build status: <strong style={{ color: statusColor(project.status) }}>{statusLabel(project.status)}</strong></span>
        <span>QA status: <strong style={{ color: statusColor(project.qaStatus ?? "qa_pending") }}>{statusLabel(project.qaStatus ?? "qa_pending")}</strong></span>
        {project.localFolderPath && <span style={{ overflowWrap: "anywhere" }}>Folder: <code>{project.localFolderPath}</code></span>}
        {port && <span>Local port: <code>{port}</code></span>}
        {project.localDevUrl ? (
          <span>Local Preview: <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ color: "#34D399" }}>{project.localDevUrl}</a></span>
        ) : (
          <span style={{ color: "#647089" }}>Local Preview: start the dev server to create a localhost URL.</span>
        )}
        {manualCommand && (
          <span>
            Manual command:
            <pre style={{ margin: "6px 0 0", padding: 9, borderRadius: 8, background: "rgba(8,13,24,0.48)", color: "#D8DEEB", font: "11px/1.45 JetBrains Mono,monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{manualCommand}</pre>
          </span>
        )}
        {showLocalhostNote && (
          <span style={{ color: "#FBBF24" }}>Localhost preview links only open on the computer running the local worker. To access from phone, enable a tunnel later.</span>
        )}
      </div>
    </div>
  );
}

function approvalLabel(action: ApprovalAction): string {
  try {
    const p = action.payload as Record<string, unknown>;
    if (action.actionType === "engineering_plan") return `Build plan: ${String(p.projectName ?? "").slice(0, 50)}`;
    if (action.actionType === "skill_scout_import") return `Skill Scout: ${String(p.candidateName ?? "candidate").slice(0, 50)}`;
    if (action.actionType === "self_improvement_proposal") return `Self-improvement: ${String(p.proposedImprovement ?? p.observedIssue ?? "proposal").slice(0, 50)}`;
    if (action.actionType === "save_memory") return `Remember: "${String(p.fact ?? "").slice(0, 50)}"`;
    if (action.actionType === "create_task") return `Task: "${String(p.title ?? "").slice(0, 50)}"`;
    return action.actionType.replace(/_/g, " ");
  } catch {
    return action.actionType;
  }
}

function average(values: number[]): number {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return 100;
  return Math.round(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

function calculateSystemHealthScore(health: HealthCenterData | null, queue: ExecutionQueueData | null) {
  const accountScore = health?.accounts.length
    ? average(health.accounts.map((account) => account.connected && !account.lastError && !account.reconnectRequired ? account.score : Math.min(account.score, 55)))
    : health ? 60 : 100;

  const scheduledScore = health?.scheduledJobs.length
    ? average(health.scheduledJobs.map((job) => {
      if (!job.enabled || job.status === "Disabled") return 85;
      if (job.status === "Healthy") return 100;
      if (job.status === "Delayed" || job.status === "Never Ran") return 65;
      return 25;
    }))
    : health ? 60 : 100;

  const executorScore = health?.executors.length
    ? average(health.executors.map((executor) => {
      const hermesReady = health.executors.some((candidate) => candidate.name === "Hermes Agent" && ["Ready", "Online", "Busy"].includes(candidate.status));
      if (executor.name === "Codex Executor" && executor.status === "Offline" && hermesReady) return 70;
      if (executor.status === "Online") return executor.lastError ? 70 : 100;
      if (executor.status === "Ready") return 100;
      if (executor.status === "Busy") return executor.lastError ? 65 : 90;
      if (executor.status === "Stale") return 60;
      return 25;
    }))
    : health ? 60 : 100;

  const apiProviderScore = health?.apiProviders?.length
    ? average(health.apiProviders.map((provider) => {
      if (provider.status === "working") return 100;
      if (provider.status === "configured_untested") return 80;
      if (provider.status === "missing") return 55;
      return 15;
    }))
    : health ? 60 : 100;

  const queueCounts = queue?.counts ?? {};
  const queueTotal = Object.values(queueCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const queueScore = queueTotal
    ? Math.max(0, Math.min(100, 100 - ((queueCounts.failed ?? 0) * 15) - ((queueCounts.waiting_approval ?? 0) * 4)))
    : 100;

  const score = average([accountScore, scheduledScore, executorScore, apiProviderScore, queueScore]);
  const status: HealthSeverity = score >= 85 ? "healthy" : score >= 65 ? "warning" : "failure";

  return {
    score,
    status,
    parts: [
      { label: "Accounts", score: accountScore },
      { label: "Scheduled", score: scheduledScore },
      { label: "Executors", score: executorScore },
      { label: "APIs", score: apiProviderScore },
      { label: "Queue", score: queueScore },
    ],
  };
}

function classifyRunSource(run: AgentRun): string {
  const text = `${run.agentName} ${run.inputSummary ?? ""} ${run.outputSummary ?? ""}`.toLowerCase();
  if (text.includes("job")) return "Job Scout";
  if (text.includes("email") || text.includes("gmail") || text.includes("inbox")) return "Email Scout";
  if (text.includes("qa")) return "QA";
  if (text.includes("memory") || text.includes("iris")) return "Memory";
  if (text.includes("builder") || text.includes("build") || text.includes("prometheus")) return "Builder";
  return "Agent action";
}

function buildLiveActivityFeed({
  runs,
  builds,
  projects,
  approvals,
  memoryDebug,
  health,
}: {
  runs: AgentRun[];
  builds: Build[];
  projects: Project[];
  approvals: ApprovalAction[];
  memoryDebug: MemoryContextDebugData | null;
  health: HealthCenterData | null;
}) {
  const items: Array<{ id: string; timestamp: string; source: string; message: string; status?: string }> = [
    ...runs.slice(0, 20).map((run) => ({
      id: `run-${run.id}`,
      timestamp: run.createdAt,
      source: classifyRunSource(run),
      message: run.outputSummary ?? run.inputSummary ?? `${run.agentName} run`,
      status: run.status,
    })),
    ...builds.slice(0, 10).map((build) => ({
      id: `build-${build.id}`,
      timestamp: build.completedAt ?? build.startedAt ?? build.createdAt,
      source: "Builder",
      message: build.resultSummary ?? build.implementationSummary ?? build.title,
      status: build.status,
    })),
    ...projects.filter((project) => project.qaStatus || project.polishReview || project.designReview).slice(0, 10).map((project) => ({
      id: `project-${project.id}`,
      timestamp: project.updatedAt,
      source: project.qaStatus?.startsWith("qa_") ? "QA" : "Builder",
      message: `${project.projectName}: ${statusLabel(project.qaStatus ?? project.status)}`,
      status: project.qaStatus ?? project.status,
    })),
    ...approvals.filter((approval) => approval.status === "pending").slice(0, 10).map((approval) => ({
      id: `approval-${approval.id}`,
      timestamp: approval.createdAt,
      source: "Approvals",
      message: approvalLabel(approval),
      status: approval.status,
    })),
    ...(memoryDebug?.recentFailures ?? []).slice(0, 6).map((failure) => ({
      id: `failure-${failure.tool}-${failure.timestamp}`,
      timestamp: failure.timestamp,
      source: "Memory",
      message: `${failure.tool}: ${failure.reason}`,
      status: "warning",
    })),
    ...(health?.logs ?? []).slice(0, 10).map((log) => ({
      id: `health-${log.timestamp}-${log.component}`,
      timestamp: log.timestamp,
      source: log.component,
      message: log.message,
      status: log.status,
    })),
  ];

  return items
    .filter((item) => item.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 12);
}

// ── Card & layout primitives ──────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: "rgba(26, 35, 54, 0.85)",
  border: "1px solid #28324A",
  borderRadius: 16,
  backdropFilter: "blur(12px)",
  padding: "20px 24px",
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: "5px 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: active ? "1px solid #A78BFA" : "1px solid #28324A",
  background: active ? "rgba(167,139,250,0.15)" : "transparent",
  color: active ? "#A78BFA" : "#94A3B8",
  transition: "all 0.15s",
  letterSpacing: "0.02em",
});

const badgeStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  color,
  background: `${color}20`,
  border: `1px solid ${color}40`,
  textTransform: "capitalize",
});

const smallButtonStyle = (color: string): React.CSSProperties => ({
  padding: "6px 9px",
  borderRadius: 8,
  border: `1px solid ${color}55`,
  background: `${color}18`,
  color,
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
});

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ flex: 1, height: 6, background: "#28324A", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #A78BFA, #60A5FA)", borderRadius: 999, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: 12, color: "#94A3B8", minWidth: 50, textAlign: "right" }}>
        {done}/{total}
      </span>
    </div>
  );
}

// ── Overview panel ────────────────────────────────────────────────────────────

function OverviewPanel({
  projects,
  approvals,
  builds,
  queue,
  runs,
  health,
  memoryDebug,
  skills,
  chatMessages,
  onApprove,
  onReject,
  onTabSwitch,
  onOfficeSelect,
}: {
  projects: Project[];
  approvals: ApprovalAction[];
  builds: Build[];
  queue: ExecutionQueueData | null;
  runs: AgentRun[];
  health: HealthCenterData | null;
  memoryDebug: MemoryContextDebugData | null;
  skills: SkillView[];
  chatMessages: ChatMessage[];
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onTabSwitch: (tab: Tab) => void;
  onOfficeSelect: (office: AgentOffice) => void;
}) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRuns = runs.filter((r) => new Date(r.createdAt) >= todayStart);
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const activeTasks = (queue?.tasks ?? []).filter((t) => ["queued", "planning", "executing", "waiting_approval", "qa_pending"].includes(t.status));
  const jobRunsToday = todayRuns.filter((r) => /job|athena/i.test(`${r.agentName} ${r.inputSummary ?? ""}`));
  const emailRunsToday = todayRuns.filter((r) => /email|iris|gmail|inbox/i.test(`${r.agentName} ${r.inputSummary ?? ""}`));
  const skillRunsToday = todayRuns.filter((r) => /skill|sophos/i.test(`${r.agentName} ${r.inputSummary ?? ""}`));
  const buildPassed = projects.filter((p) => ["qa_passed", "completed", "Dev Server Running"].includes(p.qaStatus ?? p.status)).length + builds.filter((b) => ["completed", "deployed"].includes(b.status)).length;
  const buildFailed = projects.filter((p) => ["qa_failed", "Build Failed", "failed"].includes(p.qaStatus ?? p.status)).length + builds.filter((b) => ["failed"].includes(b.status)).length;
  const accountIssues = health?.accounts.filter((a) => !a.connected || a.reconnectRequired || a.lastError).length ?? 0;
  const schedulerIssues = health?.scheduledJobs.filter((j) => ["Delayed", "Failed", "Never Ran"].includes(j.status)).length ?? 0;
  const emailHealthy = health?.executors.find((e) => e.name === "Email Intelligence")?.status !== "Offline";
  const memoryStatus = memoryDebug?.activeIntent ?? "ready";
  const systemHealth = calculateSystemHealthScore(health, queue);
  const liveActivity = buildLiveActivityFeed({ runs, builds, projects, approvals, memoryDebug, health });

  const metrics = [
    { label: "Active tasks", value: activeTasks.length, tone: "#A78BFA", tab: "overview" as Tab },
    { label: "Queued tasks", value: queue?.counts?.queued ?? 0, tone: "#60A5FA", tab: "overview" as Tab },
    { label: "Failed tasks", value: queue?.counts?.failed ?? 0, tone: "#F87171", tab: "overview" as Tab },
    { label: "Completed tasks", value: queue?.counts?.completed ?? 0, tone: "#34D399", tab: "overview" as Tab },
    { label: "Jobs found today", value: jobRunsToday.length, tone: "#E879F9", tab: "logs" as Tab },
    { label: "Important emails", value: emailRunsToday.length, tone: "#F472B6", tab: "logs" as Tab },
    { label: "Skills scouted", value: skillRunsToday.length || skills.length, tone: "#38BDF8", tab: "skills" as Tab },
    { label: "Builds pass/fail", value: `${buildPassed}/${buildFailed}`, tone: buildFailed > 0 ? "#FBBF24" : "#34D399", tab: "projects" as Tab },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...missionCardStyle, padding: "10px 12px", display: "grid", gridTemplateColumns: "minmax(180px, 1fr) repeat(5, minmax(110px, auto))", gap: 10, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#F1F4FB", fontSize: 16, fontWeight: 850, fontFamily: "Fraunces, serif", lineHeight: 1 }}>Mission Control</div>
          <div style={{ color: "#647089", fontSize: 10, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{health?.overall.message ?? "Live"} / {memoryStatus}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(systemHealth.status), boxShadow: `0 0 14px ${statusColor(systemHealth.status)}66` }} />
          <span style={{ color: "#94A3B8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>System</span>
          <strong style={{ color: "#F1F4FB", fontSize: 18, lineHeight: 1, fontFamily: "Fraunces, serif" }}>{systemHealth.score}%</strong>
        </div>
        {[
          { label: "Accounts", value: accountIssues ? `${accountIssues} issue` : "healthy", color: accountIssues ? "#FBBF24" : "#34D399" },
          { label: "Scheduler", value: schedulerIssues ? `${schedulerIssues} issue` : "healthy", color: schedulerIssues ? "#FBBF24" : "#34D399" },
          { label: "Email", value: emailHealthy ? "ready" : "offline", color: emailHealthy ? "#34D399" : "#F87171" },
          { label: "Build", value: `${buildPassed}/${buildFailed}`, color: buildFailed ? "#FBBF24" : "#34D399" },
        ].map((item) => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 7, justifyContent: "flex-end" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: item.color, boxShadow: `0 0 12px ${item.color}66` }} />
            <span style={{ color: "#94A3B8", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>{item.label}</span>
            <strong style={{ color: "#F1F4FB", fontSize: 11 }}>{item.value}</strong>
          </div>
        ))}
      </div>

      <MissionHealthBar health={health} queue={queue} memoryDebug={memoryDebug} />

      <SystemHealthScorePanel health={systemHealth} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
        {metrics.map((metric) => (
          <button key={metric.label} onClick={() => onTabSwitch(metric.tab)} style={{ ...missionCardStyle, textAlign: "left", cursor: "pointer", minHeight: 70, padding: "11px 12px" }}>
            <div style={{ color: metric.tone, fontSize: 21, fontWeight: 850, fontFamily: "Fraunces, serif", lineHeight: 1 }}>{metric.value}</div>
            <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 8 }}>{metric.label}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 10, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <AgentCommandPanel runs={runs} health={health} projects={projects} memoryDebug={memoryDebug} onTabSwitch={onTabSwitch} onOfficeSelect={onOfficeSelect} />
          <MissionQueuePanel queue={queue} approvals={pendingApprovals} onApprove={onApprove} onReject={onReject} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <LiveActivityFeed items={liveActivity} />
          <ActivitySection runs={runs} builds={builds} projects={projects} skills={skills} />
          <LiveBuildConsole />
        </div>
      </div>
    </div>
  );
}

const missionCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(27,36,55,0.92), rgba(15,22,38,0.88))",
  border: "1px solid rgba(93,111,143,0.28)",
  borderRadius: 10,
  boxShadow: "0 12px 30px rgba(0,0,0,0.18)",
  backdropFilter: "blur(14px)",
  padding: "12px 14px",
};

function IndicatorChip({ label, status, detail, onClick }: { label: string; status: string; detail: string; onClick?: () => void }) {
  const color = statusColor(status);
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, padding: "7px 9px", borderRadius: 9, border: "1px solid rgba(93,111,143,0.24)", background: "rgba(8,13,24,0.44)", cursor: onClick ? "pointer" : "default", color: "#D8DEEB" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 16px ${color}66`, flexShrink: 0 }} />
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        <span style={{ color: "#F1F4FB", fontSize: 11, fontWeight: 800, lineHeight: 1 }}>{label}</span>
        <span style={{ color: "#94A3B8", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{detail}</span>
      </span>
    </button>
  );
}

function MissionHealthBar({ health, queue, memoryDebug }: { health: HealthCenterData | null; queue: ExecutionQueueData | null; memoryDebug: MemoryContextDebugData | null }) {
  const accountsDisconnected = health?.accounts.filter((a) => !a.connected || a.reconnectRequired || a.lastError).length ?? 0;
  const delayedJobs = health?.scheduledJobs.filter((j) => ["Delayed", "Failed", "Never Ran"].includes(j.status)).length ?? 0;
  const hermesReady = health?.executors.some((executor) => executor.name === "Hermes Agent" && ["Ready", "Online", "Busy"].includes(executor.status)) ?? false;
  const executorIssues = health?.executors.filter((e) => (e.status === "Offline" || e.lastError) && !(e.name === "Codex Executor" && hermesReady)).length ?? 0;
  const executorWarnings = health?.executors.filter((e) => e.status === "Stale" || (e.name === "Codex Executor" && e.status === "Offline" && hermesReady)).length ?? 0;
  const notificationIssues = health?.notifications.filter((n) => n.status !== "healthy" || n.lastFailed).length ?? 0;
  const queueFailures = queue?.counts?.failed ?? 0;
  const memoryIssues = (memoryDebug?.recentFailures.length ?? 0) + (memoryDebug?.toolHealth.filter((t) => t.status === "unavailable").length ?? 0);

  return (
    <div style={{ ...missionCardStyle, padding: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 6 }}>
      <IndicatorChip label="Accounts" status={accountsDisconnected ? "warning" : "healthy"} detail={accountsDisconnected ? `${accountsDisconnected} need attention` : "connected"} />
      <IndicatorChip label="Scheduled jobs" status={delayedJobs ? "warning" : "healthy"} detail={delayedJobs ? `${delayedJobs} delayed` : "on schedule"} />
      <IndicatorChip label="Executors" status={executorIssues ? "failure" : executorWarnings ? "warning" : "healthy"} detail={executorIssues ? `${executorIssues} issue` : executorWarnings ? `${executorWarnings} warning` : "available"} />
      <IndicatorChip label="Memory context" status={memoryIssues ? "warning" : "healthy"} detail={memoryDebug?.activeIntent ?? "ready"} />
      <IndicatorChip label="Notifications" status={notificationIssues ? "warning" : "healthy"} detail={notificationIssues ? `${notificationIssues} warning` : "healthy"} />
      <IndicatorChip label="Queue" status={queueFailures ? "failure" : (queue?.counts?.executing ?? 0) > 0 ? "Busy" : "healthy"} detail={`${queue?.counts?.executing ?? 0} running / ${queueFailures} failed`} />
    </div>
  );
}

function SystemHealthScorePanel({ health }: { health: ReturnType<typeof calculateSystemHealthScore> }) {
  return (
    <div style={{ ...missionCardStyle, padding: "9px 10px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "120px repeat(5, minmax(0, 1fr))", gap: 8, alignItems: "center" }}>
        <div>
          <div style={{ color: statusColor(health.status), fontSize: 24, lineHeight: 1, fontWeight: 900, fontFamily: "Fraunces, serif" }}>{health.score}%</div>
          <div style={{ color: "#94A3B8", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 4 }}>System health</div>
        </div>
        {health.parts.map((part) => {
          const color = part.score >= 85 ? "#34D399" : part.score >= 65 ? "#FBBF24" : "#F87171";
          return (
            <div key={part.label} style={{ minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#D8DEEB", fontSize: 11, fontWeight: 800 }}>
                <span>{part.label}</span>
                <span style={{ color }}>{part.score}%</span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: "#1B253A", overflow: "hidden", marginTop: 6 }}>
                <div style={{ width: `${part.score}%`, height: "100%", borderRadius: 999, background: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveActivityFeed({ items }: { items: Array<{ id: string; timestamp: string; source: string; message: string; status?: string }> }) {
  return (
    <div style={missionCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#F1F4FB", fontSize: 15, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Live Activity</div>
        <div style={{ color: "#647089", fontSize: 11 }}>{items.length ? `${items.length} recent events` : "No events yet"}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 258, overflow: "auto", paddingRight: 4 }}>
        {items.map((item) => (
          <div key={item.id} style={{ display: "grid", gridTemplateColumns: "72px 94px minmax(0, 1fr)", gap: 8, alignItems: "center", padding: "7px 8px", borderRadius: 8, border: "1px solid rgba(93,111,143,0.2)", background: "rgba(8,13,24,0.35)" }}>
            <span style={{ color: "#647089", fontSize: 10 }}>{timeAgo(item.timestamp)}</span>
            <span style={{ color: statusColor(item.status ?? item.source), fontSize: 10, fontWeight: 850, letterSpacing: "0.04em", textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.source}</span>
            <span style={{ color: "#D8DEEB", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.message}</span>
          </div>
        ))}
        {!items.length && <div style={{ color: "#647089", fontSize: 12 }}>Recent events from scouts, builder, QA, memory, approvals, and agents will appear here.</div>}
      </div>
    </div>
  );
}

function AgentCommandPanel({ runs, health, projects, memoryDebug, onTabSwitch, onOfficeSelect }: { runs: AgentRun[]; health: HealthCenterData | null; projects: Project[]; memoryDebug: MemoryContextDebugData | null; onTabSwitch: (tab: Tab) => void; onOfficeSelect: (office: AgentOffice) => void }) {
  const agentKeys = ["Hermes", "Builder", "Athena", "Iris", "Mercury", "Fugu", "Kairos"];
  const activeBuild = projects.find((p) => ["building", "active", "qa_pending", "qa_running"].includes(p.status) || ["qa_pending", "qa_running"].includes(p.qaStatus ?? ""));

  const agentInfo = agentKeys.map((name) => {
    const run = runs.find((r) => new RegExp(name === "Builder" ? "builder|prometheus|local" : name, "i").test(`${r.agentName} ${r.inputSummary ?? ""}`));
    const executor = health?.executors.find((e) => new RegExp(name === "Builder" ? "builder|local" : name, "i").test(e.name));
    const lastError = executor?.lastError ?? (run?.status === "failed" ? run.outputSummary : null);
    const currentTask =
      name === "Hermes" ? memoryDebug?.activeIntent ?? "routing" :
      name === "Builder" ? activeBuild?.projectName ?? "idle" :
      run?.inputSummary?.slice(0, 80) ?? "idle";
    return {
      name,
      status: executor?.status ?? (lastError ? "Offline" : "Online"),
      currentTask,
      lastRun: executor?.lastRun ?? run?.createdAt ?? null,
      lastError,
      office: ({ Hermes: "hermes", Athena: "athena", Builder: "builder", Iris: "iris", Fugu: "fugu" } as Partial<Record<string, AgentOffice>>)[name],
      tab: ({ Hermes: true, Athena: true, Builder: true, Iris: true, Fugu: true } as Record<string, boolean>)[name] ? "agents" as Tab : "logs" as Tab,
    };
  });

  return (
    <div style={missionCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <div style={{ color: "#F1F4FB", fontSize: 15, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Agent Deck</div>
        </div>
        <button onClick={() => onTabSwitch("agents")} style={{ padding: "6px 9px", borderRadius: 8, border: "1px solid rgba(167,139,250,0.35)", background: "rgba(167,139,250,0.12)", color: "#C4B5FD", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Talk to Agents</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 7 }}>
        {agentInfo.map((agent) => (
          <button key={agent.name} onClick={() => { if (agent.office) onOfficeSelect(agent.office); onTabSwitch(agent.tab); }} style={{ minHeight: 108, borderRadius: 9, border: `1px solid ${statusColor(agent.status)}35`, background: "rgba(8,13,24,0.44)", padding: 9, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <strong style={{ color: "#F1F4FB", fontSize: 12 }}>{agent.name}</strong>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(agent.status), flexShrink: 0 }} />
              </div>
              <div style={{ color: "#94A3B8", fontSize: 10, marginTop: 7, lineHeight: 1.3, maxHeight: 28, overflow: "hidden" }}>{agent.currentTask}</div>
            </div>
            <div>
              <div style={{ color: agent.lastError ? "#F87171" : "#647089", fontSize: 10, minHeight: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.lastError ?? "no errors"}</div>
              <div style={{ color: "#647089", fontSize: 10, marginTop: 3 }}>{agent.lastRun ? timeAgo(agent.lastRun) : "never ran"}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MissionQueuePanel({ queue, approvals, onApprove, onReject }: { queue: ExecutionQueueData | null; approvals: ApprovalAction[]; onApprove: (id: string) => Promise<void>; onReject: (id: string) => Promise<void> }) {
  const queueStatuses = ["queued", "planning", "executing", "waiting_approval", "completed", "failed", "cancelled"] as const;
  return (
    <div style={missionCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#F1F4FB", fontSize: 15, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Execution Queue</div>
        {queue?.lastUpdated && <span style={{ color: "#647089", fontSize: 11 }}>Updated {timeAgo(queue.lastUpdated)}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 6, marginBottom: 8 }}>
        {queueStatuses.map((status) => (
          <div key={status} style={{ borderRadius: 9, border: "1px solid rgba(93,111,143,0.24)", background: "rgba(8,13,24,0.36)", padding: "8px 9px" }}>
            <div style={{ color: statusColor(status), fontSize: 18, fontWeight: 900, lineHeight: 1 }}>{queue?.counts?.[status] ?? 0}</div>
            <div style={{ color: "#94A3B8", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 6 }}>{statusLabel(status)}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(queue?.tasks ?? []).slice(0, 5).map((task) => (
            <div key={task.id} style={{ padding: "8px 10px", borderRadius: 9, border: "1px solid rgba(93,111,143,0.2)", background: "rgba(15,22,38,0.6)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={badgeStyle(statusColor(task.status))}>{statusLabel(task.status)}</span>
                <span style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 700, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
                <span style={{ color: "#647089", fontSize: 11 }}>{task.assignedExecutor}</span>
              </div>
              {(task.result || task.logs.at(-1)) && <div style={{ color: "#94A3B8", fontSize: 10, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.result ?? task.logs.at(-1)}</div>}
            </div>
          ))}
          {!(queue?.tasks ?? []).length && <div style={{ color: "#647089", fontSize: 13 }}>No execution queue records yet.</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Waiting Approval</div>
          {approvals.slice(0, 3).map((approval) => (
            <div key={approval.id} style={{ padding: 8, borderRadius: 9, border: "1px solid rgba(251,191,36,0.25)", background: "rgba(251,191,36,0.07)" }}>
              <div style={{ color: "#F1F4FB", fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{approvalLabel(approval)}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => onApprove(approval.id)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.38)", color: "#34D399", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Approve</button>
                <button onClick={() => onReject(approval.id)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#F87171", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>Reject</button>
              </div>
            </div>
          ))}
          {approvals.length === 0 && <div style={{ color: "#647089", fontSize: 12 }}>No pending approvals.</div>}
        </div>
      </div>
    </div>
  );
}

function RunInspectorPanel({
  runs,
  selectedRunId,
  events,
  onSelect,
  onCancel,
  onRetry,
  onFallback,
  onCopyDiagnostic,
}: {
  runs: ExecutionRun[];
  selectedRunId: string | null;
  events: ExecutionTraceEvent[];
  onSelect: (runId: string) => void;
  onCancel: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onFallback: (runId: string) => Promise<void>;
  onCopyDiagnostic: (run: ExecutionRun, events: ExecutionTraceEvent[]) => Promise<void>;
}) {
  const selected = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const eventTail = events.slice(-8).reverse();
  const fuguStatus = events.slice().reverse().find((event) => event.phase.includes("fugu"))?.message
    ?? "No Fugu event recorded yet.";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.9fr) minmax(420px, 1.6fr)", gap: 12 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12 }}>
          <div style={{ color: "#F1F4FB", fontSize: 16, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Run Inspector</div>
          <span style={{ color: "#647089", fontSize: 11 }}>{runs.length} recent</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => onSelect(run.id)}
              style={{ textAlign: "left", borderRadius: 8, border: selected?.id === run.id ? "1px solid rgba(167,139,250,0.55)" : "1px solid rgba(93,111,143,0.22)", background: selected?.id === run.id ? "rgba(167,139,250,0.12)" : "rgba(8,13,24,0.36)", padding: 10, cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={badgeStyle(statusColor(run.status))}>{statusLabel(run.status)}</span>
                <span style={{ color: "#F1F4FB", fontSize: 12, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.currentActivity ?? run.currentPhase}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 7, color: "#647089", fontSize: 10 }}>
                <span>{run.executor}</span>
                <span>{statusLabel(run.currentPhase)}</span>
                <span>{timeAgo(run.startedAt)}</span>
              </div>
            </button>
          ))}
          {!runs.length && <div style={{ color: "#647089", fontSize: 13 }}>No execution runs yet.</div>}
        </div>
      </div>
      <div style={cardStyle}>
        {!selected ? (
          <div style={{ color: "#647089", fontSize: 13 }}>Queue a local build to inspect its live execution trace.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={badgeStyle(statusColor(selected.status))}>{statusLabel(selected.status)}</span>
                  <span style={badgeStyle(statusColor(selected.currentPhase))}>{statusLabel(selected.currentPhase)}</span>
                  <span style={badgeStyle("#A78BFA")}>{selected.executor}</span>
                </div>
                <div style={{ color: "#F1F4FB", fontSize: 18, fontWeight: 850, fontFamily: "Fraunces, serif", marginTop: 8 }}>{selected.currentActivity ?? "No activity yet"}</div>
              </div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button onClick={() => onCancel(selected.id)} disabled={["completed", "failed", "cancelled"].includes(selected.status)} style={smallButtonStyle("#FBBF24")}>Cancel</button>
                <button onClick={() => onRetry(selected.id)} style={smallButtonStyle("#60A5FA")}>Retry</button>
                <button onClick={() => onFallback(selected.id)} style={smallButtonStyle("#A78BFA")}>Switch to Codex</button>
                <button onClick={() => onCopyDiagnostic(selected, events)} style={smallButtonStyle("#34D399")}>Copy diagnostic</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
              {[
                ["Elapsed", `${Math.round(selected.elapsedMs / 1000)}s`],
                ["Last progress", timeAgo(selected.lastMeaningfulEventAt)],
                ["Heartbeat", `${Math.round(selected.heartbeatAgeMs / 1000)}s ago`],
                ["Worker", selected.workerId ?? "unclaimed"],
                ["Project", selected.projectId ?? "none"],
                ["Task", selected.taskId ?? "none"],
                ["Folder", selected.localFolderPath ?? "none"],
                ["Fugu", fuguStatus],
              ].map(([label, value]) => (
                <div key={label} style={{ borderRadius: 8, border: "1px solid rgba(93,111,143,0.2)", background: "rgba(8,13,24,0.34)", padding: 8 }}>
                  <div style={{ color: "#647089", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 800 }}>{label}</div>
                  <div style={{ color: "#D8DEEB", fontSize: 11, marginTop: 5, wordBreak: "break-word" }}>{value}</div>
                </div>
              ))}
            </div>
            {selected.stuckReason && <div style={{ borderRadius: 8, border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)", color: "#FBBF24", padding: 9, fontSize: 12 }}>{selected.stuckReason}</div>}
            {selected.cancellationRequestedAt && <div style={{ color: "#FBBF24", fontSize: 12 }}>Cancellation requested {timeAgo(selected.cancellationRequestedAt)}; waiting for worker confirmation.</div>}
            {selected.fallbackReason && <div style={{ color: "#A78BFA", fontSize: 12 }}>Fallback history: {selected.fallbackReason}</div>}
            {selected.lastSafeError && <div style={{ color: "#F87171", fontSize: 12 }}>Last safe error: {selected.lastSafeError}</div>}
            <div>
              <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Timeline</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {eventTail.map((event) => (
                  <div key={event.id} style={{ borderRadius: 8, border: `1px solid ${statusColor(event.severity)}33`, background: "rgba(8,13,24,0.35)", padding: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ color: "#F1F4FB", fontSize: 12, fontWeight: 800 }}>{event.message}</div>
                      <span style={{ color: "#647089", fontSize: 10, flexShrink: 0 }}>{timeAgo(event.createdAt)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 7, marginTop: 5, flexWrap: "wrap" }}>
                      <span style={badgeStyle(statusColor(event.severity))}>{event.severity}</span>
                      <span style={badgeStyle(statusColor(event.phase))}>{statusLabel(event.phase)}</span>
                      <span style={badgeStyle("#647089")}>{event.source}</span>
                    </div>
                    {event.safeDetails && (
                      <details style={{ marginTop: 7 }}>
                        <summary style={{ color: "#94A3B8", fontSize: 11, cursor: "pointer" }}>Safe details</summary>
                        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#94A3B8", fontSize: 10, margin: "6px 0 0" }}>{JSON.stringify(event.safeDetails, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                ))}
                {!events.length && <div style={{ color: "#647089", fontSize: 13 }}>No trace events yet.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActivitySection({ runs, builds, projects, skills }: { runs: AgentRun[]; builds: Build[]; projects: Project[]; skills: SkillView[] }) {
  const completedRuns = runs.filter((r) => r.status === "completed").length;
  const failedRuns = runs.filter((r) => r.status === "failed").length;
  const buildSuccess = builds.length + projects.length > 0 ? Math.round((projects.filter((p) => !/failed/i.test(p.status) && !/failed/i.test(p.qaStatus ?? "")).length + builds.filter((b) => b.status !== "failed").length) / Math.max(1, projects.length + builds.length) * 100) : 0;
  const blocks = [
    { label: "Task completion trend", value: `${completedRuns}/${completedRuns + failedRuns}`, detail: "recent agent runs", color: "#34D399" },
    { label: "Job scout activity", value: runs.filter((r) => /job|athena/i.test(`${r.agentName} ${r.inputSummary ?? ""}`)).length, detail: "tracked signals", color: "#E879F9" },
    { label: "Email attention activity", value: runs.filter((r) => /email|iris|gmail/i.test(`${r.agentName} ${r.inputSummary ?? ""}`)).length, detail: "recent scans", color: "#F472B6" },
    { label: "Build success rate", value: `${buildSuccess}%`, detail: "projects and builds", color: buildSuccess >= 70 ? "#34D399" : "#FBBF24" },
    { label: "Skill scout activity", value: skills.length, detail: "installed skills", color: "#38BDF8" },
  ];

  return (
    <div style={missionCardStyle}>
      <div style={{ color: "#F1F4FB", fontSize: 15, fontWeight: 850, fontFamily: "Fraunces, serif", marginBottom: 8 }}>Analytics</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 7 }}>
        {blocks.map((block) => (
          <div key={block.label} style={{ padding: 9, borderRadius: 9, background: "rgba(8,13,24,0.4)", border: "1px solid rgba(93,111,143,0.2)" }}>
            <div style={{ color: block.color, fontSize: 18, fontWeight: 900, fontFamily: "Fraunces, serif", lineHeight: 1 }}>{block.value}</div>
            <div style={{ color: "#D8DEEB", fontSize: 10, fontWeight: 800, marginTop: 6 }}>{block.label}</div>
            <div style={{ height: 4, background: "#1B253A", borderRadius: 999, marginTop: 7, overflow: "hidden" }}>
              <div style={{ width: typeof block.value === "string" && block.value.endsWith("%") ? block.value : `${Math.min(100, Number(block.value) * 12 || 18)}%`, height: "100%", background: block.color, borderRadius: 999 }} />
            </div>
            <div style={{ color: "#647089", fontSize: 9, marginTop: 5 }}>{block.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompactHermesConsole({ initialMessages }: { initialMessages: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    if (!overrideText) setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: "user", content: text, channel: "dashboard", createdAt: new Date().toISOString() }]);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      const data = await res.json().catch(() => null) as { reply?: { content?: string; quickActions?: ChatQuickAction[] } } | null;
      if (res.ok && data?.reply?.content) {
        setMessages((prev) => [...prev, { id: `reply-${Date.now()}`, role: "assistant", content: data.reply!.content!, quickActions: data.reply!.quickActions, channel: "dashboard", createdAt: new Date().toISOString() }]);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ ...missionCardStyle, padding: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
        <div style={{ color: "#F1F4FB", fontSize: 14, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Talk to Hermes</div>
      </div>
      <div style={{ height: 112, overflow: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
        {messages.slice(-6).map((message) => (
          <div key={message.id} style={{ alignSelf: message.role === "user" ? "flex-end" : "flex-start", maxWidth: "92%" }}>
            <div style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid rgba(93,111,143,0.2)", background: message.role === "user" ? "rgba(167,139,250,0.14)" : "rgba(8,13,24,0.44)", color: "#D8DEEB", fontSize: 11, lineHeight: 1.35, whiteSpace: "pre-wrap" }}>{message.content}</div>
            {message.role === "assistant" && message.quickActions?.length ? (
              <div style={{ display: "grid", gap: 5, marginTop: 6 }}>
                {message.quickActions.map((action) => (
                  <button key={action.id} type="button" disabled={sending} onClick={() => void send(action.value)} title={action.description} style={{ textAlign: "left", borderRadius: 8, border: "1px solid rgba(52,211,153,0.36)", background: "rgba(52,211,153,0.12)", color: "#34D399", padding: "6px 8px", fontSize: 11, fontWeight: 800, cursor: sending ? "not-allowed" : "pointer" }}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {messages.length === 0 && <div style={{ color: "#647089", fontSize: 12 }}>No dashboard commands yet.</div>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={{ display: "flex", gap: 7, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
          disabled={sending}
          placeholder="Command Hermes..."
          style={{ flex: 1, minWidth: 0, background: "rgba(8,13,24,0.62)", border: "1px solid rgba(93,111,143,0.32)", color: "#F1F4FB", borderRadius: 9, padding: "8px 9px", outline: "none", fontSize: 12, opacity: sending ? 0.7 : 1 }}
        />
        <button type="submit" disabled={sending} style={{ padding: "0 11px", borderRadius: 9, border: "1px solid rgba(167,139,250,0.35)", background: "rgba(167,139,250,0.14)", color: "#C4B5FD", fontSize: 12, fontWeight: 850, cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.55 : 1 }}>{sending ? "..." : "Send"}</button>
      </form>
    </div>
  );
}

// ── Projects panel ────────────────────────────────────────────────────────────

function AgentTalkPanel() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 14, alignItems: "stretch" }}>
      <div style={cardStyle}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>Talk to your agents</div>
          <h2 style={{ margin: "6px 0 0", fontSize: 24, fontFamily: "Fraunces, serif" }}>Agent Roster</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 6 }}>
          <AgentRoster agents={CHAT_ROSTER_AGENTS} />
        </div>
      </div>
      <div style={cardStyle}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>Reviewer offices</div>
          <h2 style={{ margin: "6px 0 0", fontSize: 24, fontFamily: "Fraunces, serif" }}>Council Offices</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 6 }}>
          <AgentRoster agents={COUNCIL_REVIEWER_AGENTS} />
        </div>
      </div>
      <CouncilChatPanel />
      <HermesNousChatPanel />
    </div>
  );
}

function AgentOfficesPanel({
  selectedOffice,
  onOfficeSelect,
  projects,
  builds,
  approvals,
  queue,
  runs,
  memoryOffice,
  memoryDebug,
}: {
  selectedOffice: AgentOffice;
  onOfficeSelect: (office: AgentOffice) => void;
  projects: Project[];
  builds: Build[];
  approvals: ApprovalAction[];
  queue: ExecutionQueueData | null;
  runs: AgentRun[];
  memoryOffice: MemoryOfficeData | null;
  memoryDebug: MemoryContextDebugData | null;
}) {
  const offices: Array<{ key: AgentOffice; label: string; detail: string; color: string }> = [
    { key: "hermes", label: "Hermes Office", detail: "tasks, plans, approvals, queue", color: "#A78BFA" },
    { key: "athena", label: "Athena Office", detail: "research briefs, sources, reports", color: "#E879F9" },
    { key: "builder", label: "Builder Office", detail: "projects, builds, QA", color: "#38BDF8" },
    { key: "iris", label: "Iris Office", detail: "memory, facts, context", color: "#2DD4BF" },
    { key: "fugu", label: "Fugu Office", detail: "design reviews, scores, recommendations", color: "#60A5FA" },
  ];

  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const activeTasks = (queue?.tasks ?? []).filter((task) => ["queued", "planning", "executing", "waiting_approval", "qa_pending"].includes(task.status));
  const researchProjects = projects.filter((project) => project.researchBrief);
  const designProjects = projects.filter((project) => project.designReview || project.polishReview || typeof project.designScore === "number");
  const qaProjects = projects.filter((project) => project.qaStatus || project.qaChecklist?.length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>Agent Offices</div>
            <h2 style={{ margin: "6px 0 0", fontSize: 24, fontFamily: "Fraunces, serif" }}>Operational Drilldown</h2>
          </div>
          <span style={{ color: "#647089", fontSize: 12 }}>Cards in Agent Deck open these offices.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          {offices.map((office) => (
            <button
              key={office.key}
              onClick={() => onOfficeSelect(office.key)}
              style={{
                textAlign: "left",
                padding: "10px 11px",
                borderRadius: 9,
                border: selectedOffice === office.key ? `1px solid ${office.color}` : "1px solid rgba(93,111,143,0.25)",
                background: selectedOffice === office.key ? `${office.color}18` : "rgba(8,13,24,0.38)",
                color: "#F1F4FB",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 850 }}>{office.label}</div>
              <div style={{ marginTop: 4, color: "#94A3B8", fontSize: 11 }}>{office.detail}</div>
            </button>
          ))}
        </div>
      </div>

      {selectedOffice === "hermes" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
          <MemoryList title="Tasks" empty="No active tasks" items={activeTasks.map((task) => ({ key: task.id, head: task.title, body: task.description, meta: `${statusLabel(task.status)} / ${task.assignedExecutor} / ${timeAgo(task.updatedAt)}` }))} />
          <MemoryList title="Plans" empty="No recent plans" items={builds.slice(0, 8).map((build) => ({ key: build.id, head: build.title, body: build.resultSummary ?? build.implementationSummary ?? undefined, meta: `${statusLabel(build.status)} / ${timeAgo(build.createdAt)}` }))} />
          <MemoryList title="Approvals" empty="No pending approvals" items={pendingApprovals.map((approval) => ({ key: approval.id, head: approvalLabel(approval), meta: timeAgo(approval.createdAt) }))} />
          <MemoryList title="Queue" empty="Queue is empty" items={(queue?.tasks ?? []).slice(0, 10).map((task) => ({ key: task.id, head: task.title, body: task.logs.at(-1) ?? task.result ?? undefined, meta: `${statusLabel(task.status)} / ${task.priority}` }))} />
        </div>
      )}

      {selectedOffice === "athena" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
          <MemoryList title="Research Briefs" empty="No research briefs yet" items={researchProjects.map((project) => ({ key: project.id, head: project.projectName, body: project.researchBrief?.slice(0, 520), meta: timeAgo(project.updatedAt) }))} />
          <MemoryList title="Sources" empty="No source summaries recorded" items={runs.filter((run) => /source|research|athena/i.test(`${run.agentName} ${run.inputSummary ?? ""}`)).slice(0, 10).map((run) => ({ key: run.id, head: run.inputSummary ?? run.agentName, body: run.outputSummary ?? undefined, meta: `${run.agentName} / ${timeAgo(run.createdAt)}` }))} />
          <MemoryList title="Reports" empty="No reports recorded" items={runs.filter((run) => /athena|research|report/i.test(`${run.agentName} ${run.outputSummary ?? ""}`)).slice(0, 10).map((run) => ({ key: run.id, head: run.inputSummary ?? "Research report", body: run.outputSummary ?? undefined, meta: timeAgo(run.createdAt) }))} />
        </div>
      )}

      {selectedOffice === "builder" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
            <MemoryList title="Projects" empty="No builder projects" items={projects.slice(0, 8).map((project) => ({ key: project.id, head: project.projectName, body: project.currentTask ?? project.latestInstruction ?? undefined, meta: `${statusLabel(project.status)} / ${timeAgo(project.updatedAt)}` }))} />
            <MemoryList title="Builds" empty="No builds yet" items={builds.slice(0, 8).map((build) => ({ key: build.id, head: build.title, body: build.resultSummary ?? build.sanitizedError ?? undefined, meta: statusLabel(build.status) }))} />
            <MemoryList title="QA" empty="No QA checklists yet" items={qaProjects.slice(0, 8).map((project) => ({ key: project.id, head: project.projectName, body: project.qaChecklist?.map((item) => `${item.label}: ${item.status}`).join("\n"), meta: statusLabel(project.qaStatus ?? "qa_pending") }))} />
          </div>
          <BuilderOffice />
        </div>
      )}

      {selectedOffice === "iris" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
          <MemoryList title="Memory" empty="No memories saved" items={(memoryOffice?.memories ?? []).map((memory) => ({ key: memory.id, head: memory.fact, meta: `${memory.source ?? "memory"} / ${timeAgo(memory.createdAt)}` }))} />
          <MemoryList title="Facts" empty="No user preferences saved" items={(memoryOffice?.userPreferences ?? []).map((memory) => ({ key: memory.id, head: memory.fact, meta: `${memory.source ?? "preference"} / ${timeAgo(memory.createdAt)}` }))} />
          <MemoryList title="Context" empty="No context loaded" items={[{ key: "context", head: memoryDebug?.activeIntent ?? "No active intent", body: JSON.stringify(memoryDebug?.rememberedEntities ?? {}, null, 2), meta: memoryDebug?.lastUpdated ? timeAgo(memoryDebug.lastUpdated) : undefined }]} />
          <MemoryList title="Recent Failures" empty="No recent failures" items={(memoryDebug?.recentFailures ?? []).map((failure) => ({ key: `${failure.tool}-${failure.timestamp}`, head: failure.tool, body: failure.reason, meta: timeAgo(failure.timestamp) }))} />
        </div>
      )}

      {selectedOffice === "fugu" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
          <MemoryList title="Design Reviews" empty="No Fugu reviews yet" items={designProjects.map((project) => ({ key: project.id, head: project.projectName, body: project.designReview ?? project.polishReview ?? undefined, meta: typeof project.designScore === "number" ? `${project.designScore}/10` : statusLabel(project.qaStatus ?? project.status) }))} />
          <MemoryList title="Scores" empty="No scores recorded" items={designProjects.filter((project) => typeof project.designScore === "number").map((project) => ({ key: project.id, head: `${project.projectName}: ${project.designScore}/10`, body: project.polishReview ?? undefined, meta: timeAgo(project.updatedAt) }))} />
          <MemoryList title="Recommendations" empty="No recommendations yet" items={designProjects.map((project) => ({ key: `${project.id}-rec`, head: project.projectName, body: project.designReview?.slice(0, 520) ?? project.polishReview?.slice(0, 520) ?? "Run Fugu Design Review from Builder Office.", meta: "Builder guidance only" }))} />
        </div>
      )}
    </div>
  );
}

const ORG_LINES = [
  ["Osman", "Hermes", "owner"],
  ["Hermes", "Project Manager", "delivery"],
  ["Project Manager", "Council", "advisory"],
  ["Project Manager", "Sophos", "skill agency"],
  ["Project Manager", "Prometheus", "engineering"],
  ["Project Manager", "Argus", "QA"],
  ["Project Manager", "Fugu", "design"],
  ["Project Manager", "Iris", "communications"],
  ["Hermes", "Athena", "career"],
  ["Hermes", "Themis", "HR compliance"],
] as const;

function ProjectControlPlanePanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectFlowData | null>(null);
  const [view, setView] = useState<"org" | "flow" | "tasks" | "timeline">("flow");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/command-center/project-flow?projectId=${encodeURIComponent(projectId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Project flow unavailable.");
        return body as ProjectFlowData;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [projectId]);

  if (error) {
    return (
      <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(248,113,113,0.25)", color: "#FCA5A5", fontSize: 12 }}>
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(96,165,250,0.22)", color: "#94A3B8", fontSize: 12 }}>
        Loading project control plane...
      </div>
    );
  }

  const taskById = new Map(data.tasks.map((task) => [`task:${task.id}`, task]));
  const agentNodes = data.nodes.filter((node) => node.kind === "agent").slice(0, 10);
  const workNodes = data.nodes.filter((node) => node.kind !== "agent").slice(0, 18);
  const blockers = data.edges.filter((edge) => edge.label === "blocks");

  return (
    <div style={{ marginBottom: 12, padding: 12, borderRadius: 8, border: "1px solid rgba(96,165,250,0.22)", background: "rgba(8,13,24,0.38)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "#60A5FA", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Project control plane</div>
          <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 3 }}>
            Phase {statusLabel(data.project.phase)} {data.plan ? `- plan r${data.plan.revision} ${data.plan.status}` : "- no accepted plan"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {(["org", "flow", "tasks", "timeline"] as const).map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              style={{
                padding: "6px 9px",
                borderRadius: 8,
                border: view === item ? "1px solid rgba(96,165,250,0.55)" : "1px solid rgba(93,111,143,0.25)",
                background: view === item ? "rgba(96,165,250,0.14)" : "rgba(15,23,42,0.5)",
                color: view === item ? "#BFDBFE" : "#94A3B8",
                fontSize: 11,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {item === "org" ? "Org" : item === "tasks" ? "Task graph" : item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {view === "org" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 8 }}>
          {ORG_LINES.map(([from, to, label]) => (
            <div key={`${from}-${to}`} style={{ padding: "9px 10px", borderRadius: 8, background: "rgba(40,50,74,0.32)", border: "1px solid rgba(93,111,143,0.2)" }}>
              <div style={{ fontSize: 12, color: "#F1F4FB", fontWeight: 800 }}>{from}</div>
              <div style={{ fontSize: 11, color: "#94A3B8", margin: "4px 0" }}>{label}</div>
              <div style={{ fontSize: 12, color: "#D8DEEB" }}>{to}</div>
            </div>
          ))}
        </div>
      )}

      {view === "flow" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(220px,0.9fr)", gap: 10 }}>
          <div style={{ display: "grid", gap: 7 }}>
            {workNodes.map((node) => (
              <div key={node.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 8, background: "rgba(40,50,74,0.32)" }}>
                <span style={{ fontSize: 12, color: "#F1F4FB", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
                <span style={badgeStyle(statusColor(node.status ?? node.kind))}>{statusLabel(node.status ?? node.kind)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gap: 7, alignContent: "start" }}>
            {agentNodes.map((node) => (
              <div key={node.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(15,23,42,0.55)" }}>
                <span style={{ color: agentColor(node.agentKey ?? node.label), fontWeight: 800, fontSize: 12 }}>{node.label}</span>
                <span style={{ color: "#94A3B8", fontSize: 11 }}>{data.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length} links</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "tasks" && (
        <div style={{ display: "grid", gap: 8 }}>
          {data.tasks.length === 0 && <div style={{ color: "#94A3B8", fontSize: 12 }}>No durable project tasks yet.</div>}
          {data.tasks.map((task) => {
            const blockedBy = blockers.filter((edge) => edge.to === `task:${task.id}`).map((edge) => taskById.get(edge.from)?.title).filter(Boolean);
            return (
              <div key={task.id} style={{ padding: "9px 10px", borderRadius: 8, background: "rgba(40,50,74,0.32)", border: task.blockedReason ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(93,111,143,0.18)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <div style={{ color: "#F1F4FB", fontSize: 12, fontWeight: 800 }}>{task.title}</div>
                  <span style={badgeStyle(statusColor(task.status))}>{statusLabel(task.status)}</span>
                </div>
                <div style={{ marginTop: 5, color: "#94A3B8", fontSize: 11 }}>
                  {task.assignedAgent ?? "unassigned"} - {task.outputContract ?? "no output contract"}
                  {blockedBy.length > 0 ? ` - blocked by ${blockedBy.join(", ")}` : ""}
                </div>
                {task.blockedReason && <div style={{ marginTop: 5, color: "#FCA5A5", fontSize: 11 }}>{task.blockedReason}</div>}
              </div>
            );
          })}
        </div>
      )}

      {view === "timeline" && (
        <div style={{ display: "grid", gap: 7, maxHeight: 320, overflow: "auto" }}>
          {data.timeline.slice(0, 40).map((event, index) => (
            <div key={`${event.kind}-${event.at}-${index}`} style={{ display: "grid", gridTemplateColumns: "92px minmax(0,1fr)", gap: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(40,50,74,0.28)" }}>
              <span style={{ color: "#647089", fontSize: 11 }}>{event.at ? timeAgo(event.at) : "unknown"}</span>
              <span style={{ color: "#D8DEEB", fontSize: 12 }}>{event.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectsPanel({ projects }: { projects: Project[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  if (projects.length === 0) {
    return (
      <div style={{ ...cardStyle, textAlign: "center", color: "#4B5563", padding: 48 }}>
        No projects yet. Ask Hermes to build something.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {projects.map((p) => (
        <div key={p.id} style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600, color: "#F1F4FB", fontFamily: "Fraunces, serif" }}>
                {p.projectName}
              </div>
              {p.route && (
                <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 2, fontFamily: "JetBrains Mono, monospace" }}>{p.route}</div>
              )}
              {p.localFolderPath && (
                <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 2, fontFamily: "JetBrains Mono, monospace", overflowWrap: "anywhere" }}>{p.localFolderPath}</div>
              )}
            </div>
            <span style={badgeStyle(statusColor(p.status))}>{statusLabel(p.status)}</span>
          </div>

          {p.taskCounts.total > 0 && (
            <div style={{ marginBottom: 16 }}>
              <ProgressBar done={p.taskCounts.done} total={p.taskCounts.total} />
              <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 6, display: "flex", gap: 12 }}>
                <span>{p.taskCounts.done} done</span>
                {p.taskCounts.in_progress > 0 && <span style={{ color: "#A78BFA" }}>{p.taskCounts.in_progress} in progress</span>}
                <span>{p.taskCounts.pending} pending</span>
              </div>
            </div>
          )}

          {p.latestInstruction && (
            <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 12, borderLeft: "2px solid #28324A", paddingLeft: 12, fontStyle: "italic" }}>
              {p.latestInstruction.slice(0, 200)}
            </div>
          )}

          {p.currentTask && (
            <div style={{ fontSize: 12, color: "#F1F4FB", marginBottom: 12 }}>
              Current task: {p.currentTask}
            </div>
          )}

          {(p.localFolderPath || p.localDevUrl) && <LocalPreviewDetails project={p} />}

          <ProjectControlPlanePanel projectId={p.id} />

          {(p.qaStatus || p.qaChecklist?.length) && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: "#FBBF24", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Local builder QA
                </div>
                {p.qaStatus && <span style={badgeStyle(statusColor(p.qaStatus))}>{statusLabel(p.qaStatus)}</span>}
              </div>
              {p.qaChecklist?.length ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
                  {p.qaChecklist.map((item) => (
                    <div key={item.key} style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 7, color: "#94A3B8", fontSize: 11 }}>
                      <span style={{ color: qaColor(item.status), fontWeight: 800 }}>{item.status === "passed" ? "✓" : item.status === "failed" ? "!" : "-"}</span>
                      <span><strong style={{ color: "#D8DEEB" }}>{item.label}</strong><br />{item.detail}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "#94A3B8", fontSize: 12 }}>QA checklist has not been run yet.</div>
              )}
            </div>
          )}

          {p.researchBrief && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(232,121,249,0.08)", border: "1px solid rgba(232,121,249,0.22)", borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#E879F9", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                Athena research brief
              </div>
              <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", font: "11px/1.5 JetBrains Mono,monospace", color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.researchBrief}</pre>
            </div>
          )}

          {p.designReview && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.22)", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: "#38BDF8", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  Fugu design review
                </div>
                {typeof p.designScore === "number" && <span style={badgeStyle("#38BDF8")}>{p.designScore}/10</span>}
              </div>
              <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", font: "11px/1.5 JetBrains Mono,monospace", color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.designReview}</pre>
            </div>
          )}

          {p.polishReview && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.22)", borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "#34D399", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                Fugu polish review
              </div>
              <pre style={{ margin: 0, maxHeight: 160, overflow: "auto", font: "11px/1.5 JetBrains Mono,monospace", color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.polishReview}</pre>
            </div>
          )}

          {(p.buildLog || p.buildError) && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(40,50,74,0.3)", borderRadius: 8 }}>
              {p.buildError && <div style={{ fontSize: 12, color: "#F87171", whiteSpace: "pre-wrap", marginBottom: 8 }}>{p.buildError}</div>}
              {p.buildLog && <pre style={{ margin: 0, maxHeight: 120, overflow: "auto", font: "11px/1.5 JetBrains Mono,monospace", color: "#94A3B8", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.buildLog}</pre>}
            </div>
          )}

          {p.tasks.length > 0 && (
            <>
              <button
                onClick={() => toggle(p.id)}
                style={{ fontSize: 12, color: "#A78BFA", background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: expanded.has(p.id) ? 12 : 0 }}
              >
                {expanded.has(p.id) ? "Hide tasks" : `Show ${p.tasks.length} tasks`}
              </button>
              {expanded.has(p.id) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {p.tasks.map((t) => (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "rgba(40,50,74,0.3)", borderRadius: 8 }}>
                      <span style={{ fontSize: 16, width: 20, textAlign: "center", flexShrink: 0 }}>
                        {t.status === "done" ? "✓" : t.status === "in_progress" ? "►" : "○"}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, color: t.status === "done" ? "#94A3B8" : "#F1F4FB", textDecoration: t.status === "done" ? "line-through" : "none" }}>
                        {t.title}
                      </span>
                      {t.assignedAgent && (
                        <span style={{ fontSize: 11, color: agentColor(t.assignedAgent) }}>{t.assignedAgent}</span>
                      )}
                      <span style={badgeStyle(statusColor(t.status))}>{statusLabel(t.status)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 12, fontSize: 11, color: "#4B5563" }}>
            Updated {timeAgo(p.updatedAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

function qaColor(status: QaItem["status"]): string {
  if (status === "passed") return "#34D399";
  if (status === "failed") return "#F87171";
  return "#94A3B8";
}

function MemoryOfficePanel({
  data,
  debug,
  onCreateTestMemory,
  onMemoryAction,
}: {
  data: MemoryOfficeData | null;
  debug: MemoryContextDebugData | null;
  onCreateTestMemory: () => Promise<void>;
  onMemoryAction: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftFact, setDraftFact] = useState("");
  const create = async () => {
    setBusy(true);
    try {
      await onCreateTestMemory();
    } finally {
      setBusy(false);
    }
  };

  const confirmed = data?.confirmedFacts ?? (data?.memories ?? []).map((m) => ({
    id: m.id,
    fact: m.fact,
    source: m.source,
    date: m.approvedAt ?? m.createdAt,
    confidence: 100,
    whereUsed: [],
    pinned: false,
    archived: false,
  }));
  const inferred = data?.inferredFacts ?? [];
  const memoryCount = confirmed.length;
  const action = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await onMemoryAction(body);
      setEditingId(null);
      setDraftFact("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#2DD4BF", letterSpacing: "0.08em", textTransform: "uppercase" }}>Iris / Memory Office</div>
            <h2 style={{ fontSize: 24, margin: "6px 0 4px", fontFamily: "Fraunces, serif" }}>What Hermes Is Learning</h2>
            <div style={{ fontSize: 12, color: "#94A3B8" }}>Last updated: {data?.lastUpdated ? timeAgo(data.lastUpdated) : "not loaded"}</div>
          </div>
          <button onClick={() => void create()} disabled={busy} style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(45,212,191,0.12)", border: "1px solid rgba(45,212,191,0.35)", color: "#2DD4BF", fontWeight: 700, cursor: busy ? "not-allowed" : "pointer" }}>
            {busy ? "Creating..." : "Create test memory"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
        <div style={cardStyle}>
          <div style={{ color: "#2DD4BF", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Confirmed Facts</div>
          {confirmed.length === 0 ? <div style={{ color: "#4B5563", fontSize: 13 }}>No confirmed facts saved yet.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {confirmed.slice(0, 18).map((m) => (
                <div key={m.id} style={{ padding: "10px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid rgba(40,50,74,0.7)", borderRadius: 8 }}>
                  {editingId === m.id ? (
                    <textarea value={draftFact} onChange={(e) => setDraftFact(e.target.value)} style={{ width: "100%", minHeight: 72, background: "#0B1020", color: "#F1F4FB", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 6, padding: 8 }} />
                  ) : (
                    <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 650 }}>{m.pinned ? "Pinned: " : ""}{m.fact}</div>
                  )}
                  <div style={{ color: "#647089", fontSize: 11, marginTop: 6 }}>Source: {m.source ?? "memory"} / Date: {timeAgo(m.date)} / Confidence: {m.confidence}% / Used: {m.whereUsed.length ? m.whereUsed.join(", ") : "not used yet"}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {editingId === m.id ? (
                      <button onClick={() => void action({ action: "editMemory", memoryId: m.id, fact: draftFact })} disabled={busy} style={miniButtonStyle("#34D399")}>Save</button>
                    ) : (
                      <button onClick={() => { setEditingId(m.id); setDraftFact(m.fact); }} disabled={busy} style={miniButtonStyle("#94A3B8")}>Edit</button>
                    )}
                    <button onClick={() => void action({ action: "pinMemory", memoryId: m.id, pinned: !m.pinned })} disabled={busy} style={miniButtonStyle("#FBBF24")}>{m.pinned ? "Unpin" : "Pin"}</button>
                    <button onClick={() => void action({ action: "archiveMemory", memoryId: m.id, archived: !m.archived })} disabled={busy} style={miniButtonStyle("#A78BFA")}>{m.archived ? "Unarchive" : "Archive"}</button>
                    <button onClick={() => void action({ action: "deleteMemory", memoryId: m.id })} disabled={busy} style={miniButtonStyle("#F87171")}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#FBBF24", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Inferred Facts Awaiting Review</div>
          {inferred.length === 0 ? <div style={{ color: "#4B5563", fontSize: 13 }}>No inferred facts waiting for approval.</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {inferred.slice(0, 12).map((m) => (
                <div key={m.id} style={{ padding: "10px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid rgba(40,50,74,0.7)", borderRadius: 8 }}>
                  <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 650 }}>{m.fact}</div>
                  <div style={{ color: "#647089", fontSize: 11, marginTop: 6 }}>Source: {m.source ?? "memory-suggest"} / Date: {timeAgo(m.date)} / Confidence: {m.confidence}% / Used: {m.whereUsed.length ? m.whereUsed.join(", ") : "not used yet"}</div>
                  <button onClick={() => void action({ action: "approveSuggestion", approvalId: m.id })} disabled={busy} style={{ ...miniButtonStyle("#34D399"), marginTop: 8 }}>Approve</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <MemoryList title="Project Decisions" empty="No project decisions yet" items={(data?.projectDecisionItems ?? data?.projectDecisions ?? []).map((p) => ({ key: p.id, head: p.projectName, body: p.decision, meta: `${"source" in p ? p.source : p.status} / ${timeAgo("date" in p ? p.date : p.updatedAt)} / ${"confidence" in p ? p.confidence : 100}%` }))} />
        <MemoryList title="Operational Lessons" empty="No operational lessons yet" items={(data?.operationalLessons ?? data?.buildLessons ?? []).slice(0, 12).map((b) => ({ key: b.id, head: "lesson" in b ? b.lesson.slice(0, 120) : b.summary || "Builder run", meta: `${"source" in b ? b.source : b.status} / ${timeAgo("date" in b ? b.date : b.createdAt)} / ${"confidence" in b ? b.confidence : 75}%` }))} />
        <MemoryList title="Recent Memory Use" empty="No memory retrievals logged yet" items={(data?.recentMemoryUse ?? []).map((u) => ({ key: u.id, head: `${u.agentName ?? "agent"}${u.taskType ? ` / ${u.taskType}` : ""}`, body: `${u.retrieved.length} retrieved\n${u.retrieved.map((m) => `- ${m.fact}`).join("\n")}`, meta: `${u.runId ? `run ${u.runId.slice(0, 8)} / ` : ""}${timeAgo(u.createdAt)}` }))} />
        <MemoryList title="Research Briefs" empty="No research briefs yet" items={(data?.researchBriefs ?? []).map((b) => ({ key: b.id, head: b.projectName, body: b.brief.slice(0, 260), meta: b.updatedAt ? timeAgo(b.updatedAt) : "recent" }))} />
      </div>

      {memoryCount === 0 && (
        <div style={{ ...cardStyle, color: "#4B5563", textAlign: "center" }}>No memories saved yet</div>
      )}

      <MemoryContextDebugPanel data={debug} />
    </div>
  );
}

function MemoryContextDebugPanel({ data }: { data: MemoryContextDebugData | null }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ color: "#A78BFA", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Memory Context Debug
          </div>
        </div>
        <span style={{ color: "#4B5563", fontSize: 11 }}>{data?.lastUpdated ? `Updated ${timeAgo(data.lastUpdated)}` : "Not loaded"}</span>
      </div>

      {!data ? (
        <div style={{ color: "#4B5563", fontSize: 13 }}>Context debug data is not loaded yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
          <MemoryList
            title="Active Session"
            empty="No active session"
            items={[
              {
                key: "session",
                head: data.activeIntent ?? "No active intent",
                body: [
                  data.activeSession?.chatId ? `Session: ${data.activeSession.chatId}` : "Session: none",
                  data.activeTask ? `Task: ${data.activeTask}` : "Task: none",
                  data.activeProjectId ? `Project: ${data.activeProjectId}` : "Project: none",
                ].join("\n"),
                meta: data.activeSession?.lastUpdated ? timeAgo(data.activeSession.lastUpdated) : undefined,
              },
            ]}
          />
          <MemoryList
            title="Remembered Entities"
            empty="No entities remembered"
            items={Object.entries(data.rememberedEntities ?? {}).map(([key, value]) => ({
              key,
              head: key.replace(/([A-Z])/g, " $1").trim(),
              body: JSON.stringify(value, null, 2),
            }))}
          />
          <MemoryList
            title="Tool Health"
            empty="No tool health recorded"
            items={data.toolHealth.map((tool) => ({
              key: tool.tool,
              head: `${tool.tool}: ${tool.status}`,
              body: tool.reason ?? "Available",
              meta: tool.lastChecked ? timeAgo(tool.lastChecked) : undefined,
            }))}
          />
          <MemoryList
            title="Recent Failures"
            empty="No recent failures"
            items={data.recentFailures.map((failure) => ({
              key: `${failure.tool}-${failure.timestamp}`,
              head: failure.tool,
              body: failure.reason,
              meta: timeAgo(failure.timestamp),
            }))}
          />
          <MemoryList
            title="Pending Approvals"
            empty="No pending approvals"
            items={data.pendingApprovals.map((approval) => ({
              key: approval.id,
              head: approval.actionType,
              meta: timeAgo(approval.createdAt),
            }))}
          />
          <MemoryList
            title="Last 20 Messages Loaded"
            empty="No recent messages"
            items={data.last20MessagesLoaded.map((message) => ({
              key: message.id,
              head: `${message.role}${message.targetAgent ? ` / ${message.targetAgent}` : ""}`,
              body: message.content.slice(0, 260),
              meta: `${message.channel} / ${timeAgo(message.createdAt)}`,
            }))}
          />
        </div>
      )}
    </div>
  );
}

function MemoryList({ title, empty, items }: { title: string; empty: string; items: Array<{ key: string; head: string; body?: string; meta?: string }> }) {
  return (
    <div style={cardStyle}>
      <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>{title}</div>
      {items.length === 0 ? <div style={{ color: "#4B5563", fontSize: 13 }}>{empty}</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((item) => (
            <div key={item.key} style={{ padding: "10px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid rgba(40,50,74,0.7)", borderRadius: 8 }}>
              <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 650 }}>{item.head}</div>
              {item.body && <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 5, whiteSpace: "pre-wrap" }}>{item.body}</div>}
              {item.meta && <div style={{ color: "#4B5563", fontSize: 11, marginTop: 6 }}>{item.meta}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillsPanel({
  skills,
  registry,
  scoutResult,
  approvals,
  onScout,
  onRefresh,
  onSetEnabled,
  onTestMatch,
  onAddDuplicateProbe,
  onApprove,
  onReject,
}: {
  skills: SkillView[];
  registry: SkillRegistryData | null;
  scoutResult: SkillScoutResult | null;
  approvals: ApprovalAction[];
  onScout: (repoUrl: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSetEnabled: (skillId: string, enabled: boolean) => Promise<void>;
  onTestMatch: (skillId: string, message: string) => Promise<SkillTestResult>;
  onAddDuplicateProbe: (candidateName: string) => Promise<string>;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [repoUrl, setRepoUrl] = useState("https://github.com/wshobson/agents");
  const [error, setError] = useState<string | null>(null);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [matchText, setMatchText] = useState("score this SOC analyst role against my Security+ and CySA+ background");
  const [matchResult, setMatchResult] = useState<Record<string, SkillTestResult>>({});
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const scout = async () => {
    if (!repoUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onScout(repoUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Skill Scout failed.");
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const installed = skills.filter((skill) => skill.source === "installed" || skill.source === "built_in");
  const recentlyAdded = skills
    .filter((skill) => skill.dateAdded)
    .sort((a, b) => new Date(b.dateAdded ?? 0).getTime() - new Date(a.dateAdded ?? 0).getTime())
    .slice(0, 7);
  const recommended = skills.filter((skill) =>
    /brief|context|job|resume|soc|grc|risk|work|authorization|writing/i.test(`${skill.name} ${skill.description} ${skill.tags.join(" ")}`)
  ).slice(0, 6);
  const lastUsed = skills.filter((skill) => skill.lastUsedAt).sort((a, b) => new Date(b.lastUsedAt ?? 0).getTime() - new Date(a.lastUsedAt ?? 0).getTime()).slice(0, 6);
  const validCount = skills.filter((skill) => skill.validationStatus === "valid").length;
  const personalPresent = registry?.personalSkills.filter((skill) => skill.present).length ?? 0;
  const averageQuality = skills.length ? Math.round(skills.reduce((sum, skill) => sum + skill.skillQualityScore, 0) / skills.length) : 0;
  const strongCoreCount = registry?.personalSkills.filter((item) => {
    const skill = skills.find((entry) => entry.id === item.id);
    return item.present && (skill?.skillQualityScore ?? 0) >= 85;
  }).length ?? 0;

  const scoutApprovals = approvals.filter((approval) => approval.actionType === "skill_scout_import");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 16, alignItems: "end" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#38BDF8", letterSpacing: "0.08em", textTransform: "uppercase" }}>Sophos / Skills</div>
            <h2 style={{ fontSize: 24, margin: "6px 0 4px", fontFamily: "Fraunces, serif" }}>Skills Control Center</h2>
            <div style={{ fontSize: 12, color: "#94A3B8" }}>{skills.length} skills indexed. {personalPresent}/7 imported personal skills present. Scout only reads safe metadata and GitHub file trees.</div>
            <form onSubmit={(event) => { event.preventDefault(); void scout(); }} style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <input
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                disabled={busy}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "rgba(14,20,36,0.72)",
                  border: "1px solid #28324A",
                  borderRadius: 8,
                  padding: "10px 12px",
                  color: "#F1F4FB",
                  fontSize: 13,
                  outline: "none",
                }}
              />
              <button type="submit" disabled={busy} style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(56,189,248,0.12)", border: "1px solid rgba(56,189,248,0.35)", color: "#38BDF8", fontWeight: 700, cursor: busy ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                {busy ? "Scouting..." : "Run Skill Scout"}
              </button>
              <button type="button" onClick={() => void refresh()} disabled={refreshing} style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.35)", color: "#34D399", fontWeight: 700, cursor: refreshing ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
                {refreshing ? "Refreshing..." : "Refresh Registry"}
              </button>
            </form>
            {error && <div style={{ color: "#F87171", fontSize: 12, marginTop: 8 }}>{error}</div>}
            {duplicateMessage && <div style={{ color: "#34D399", fontSize: 12, marginTop: 8 }}>{duplicateMessage}</div>}
          </div>
          <div style={{ display: "grid", gap: 6, minWidth: 190 }}>
            <span style={badgeStyle("#34D399")}>{validCount} valid metadata</span>
            <span style={badgeStyle("#FBBF24")}>{skills.filter((skill) => skill.validationStatus !== "valid").length} warnings</span>
            <span style={badgeStyle(qualityColor(registry?.quality?.personalAverage ?? averageQuality))}>Core quality {registry?.quality?.personalAverage ?? averageQuality}%</span>
            <span style={badgeStyle("#60A5FA")}>{registry?.lastUpdated ? `Updated ${timeAgo(registry.lastUpdated)}` : "Live registry"}</span>
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
        {[
          ["Installed Skills", installed.length, "#34D399"],
          ["Avg Quality", `${averageQuality}%`, qualityColor(averageQuality)],
          ["Core >=85", `${strongCoreCount}/7`, strongCoreCount === 7 ? "#34D399" : "#FBBF24"],
          ["Usage Count", skills.reduce((sum, skill) => sum + skill.usageCount, 0), "#A78BFA"],
        ].map(([label, value, color]) => (
          <div key={label} style={{ ...cardStyle, padding: 14 }}>
            <div style={{ color: color as string, fontSize: 22, fontWeight: 900, fontFamily: "Fraunces, serif" }}>{value}</div>
            <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
        <SkillSummaryList title="Recently Added" skills={recentlyAdded} empty="No dated skills yet" />
        <SkillSummaryList title="Recommended for Current Project" skills={recommended} empty="No project recommendations yet" />
        <SkillSummaryList title="Last Used" skills={lastUsed} empty="Use Test Match to record usage" />
      </div>

      {scoutResult && (
        <div style={{ ...cardStyle, borderColor: "rgba(56,189,248,0.35)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ color: "#38BDF8", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Skill Scout Results</div>
              <h3 style={{ fontFamily: "Fraunces, serif", fontSize: 20, margin: 0 }}>{scoutResult.repo.fullName}</h3>
              <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 4 }}>{scoutResult.repo.description ?? "No repository description."}</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
              <span style={badgeStyle("#60A5FA")}>{scoutResult.inspected.treeItems} tree items</span>
              <span style={badgeStyle("#34D399")}>{scoutResult.candidates.length} candidates</span>
              <span style={badgeStyle("#FBBF24")}>{scoutResult.approvals.length} approvals</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginBottom: 16 }}>
            {scoutResult.safetyNotes.map((note) => (
              <div key={note} style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(52,211,153,0.22)", background: "rgba(52,211,153,0.07)", color: "#D8DEEB", fontSize: 12 }}>
                {note}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            {scoutResult.candidates.map((candidate) => (
              <div key={`${candidate.sourceRepo}-${candidate.sourcePath}`} style={{ padding: 14, borderRadius: 8, border: "1px solid rgba(40,50,74,0.85)", background: "rgba(15,22,38,0.42)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <strong style={{ color: "#F1F4FB", fontSize: 15 }}>{candidate.name}</strong>
                      <span style={badgeStyle(candidate.scores.priority === "high" ? "#34D399" : candidate.scores.priority === "medium" ? "#FBBF24" : "#94A3B8")}>{candidate.scores.priority}</span>
                      <span style={badgeStyle(candidate.riskLevel === "low" ? "#34D399" : candidate.riskLevel === "medium" ? "#FBBF24" : "#F87171")}>{candidate.riskLevel} risk</span>
                    </div>
                    <div style={{ color: "#94A3B8", fontSize: 12, marginBottom: 8 }}>{candidate.summary}</div>
                    <div style={{ color: "#D8DEEB", fontSize: 13, lineHeight: 1.5 }}>{candidate.whyItHelpsParawi}</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 42px)", gap: 6, flexShrink: 0 }}>
                    {[["B", candidate.scores.benefit], ["R", candidate.scores.risk], ["E", candidate.scores.effort]].map(([label, value]) => (
                      <div key={label} style={{ textAlign: "center", padding: "6px 0", borderRadius: 8, background: "rgba(40,50,74,0.55)", border: "1px solid rgba(40,50,74,0.8)" }}>
                        <div style={{ color: "#4B5563", fontSize: 10, fontWeight: 800 }}>{label}</div>
                        <div style={{ color: "#F1F4FB", fontSize: 14, fontWeight: 800 }}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: "grid", gap: 6, marginTop: 10, color: "#94A3B8", fontSize: 12 }}>
                  <span>Action: <strong style={{ color: "#38BDF8" }}>{candidate.recommendedAction}</strong></span>
                  <span>Source: <a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#38BDF8" }}>{candidate.sourcePath}</a></span>
                  <span>Overlap: {candidate.overlapWithExistingSystem}</span>
                  <span>Expected files: {candidate.expectedFilesChanged.join(", ")}</span>
                  <span>Rollback: {candidate.rollbackPlan}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {scoutApprovals.length > 0 && (
        <div style={cardStyle}>
          <div style={{ color: "#FBBF24", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Pending Skill Scout Approvals</div>
          <div style={{ display: "grid", gap: 10 }}>
            {scoutApprovals.slice(0, 8).map((approval) => {
              const payload = approval.payload as Record<string, unknown>;
              return (
                <div key={approval.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, padding: "12px 14px", border: "1px solid rgba(251,191,36,0.24)", background: "rgba(251,191,36,0.07)", borderRadius: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 750 }}>{String(payload.candidateName ?? "Skill Scout candidate")}</div>
                    <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 4 }}>{String(payload.whyItHelps ?? "")}</div>
                    <div style={{ color: "#4B5563", fontSize: 11, marginTop: 5 }}>Destination: {Array.isArray(payload.destination) ? payload.destination.join(", ") : String(payload.destination ?? "review required")}</div>
                  </div>
                  {approval.status === "pending" && (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button onClick={() => void onApprove(approval.id)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(52,211,153,0.36)", background: "rgba(52,211,153,0.12)", color: "#34D399", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Approve</button>
                      <button onClick={() => void onReject(approval.id)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(248,113,113,0.36)", background: "rgba(248,113,113,0.10)", color: "#F87171", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>Reject</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ color: "#F1F4FB", fontSize: 16, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Installed Skills</div>
            <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 3 }}>Safe metadata only. Instruction text can be opened for inspection, never executed from this panel.</div>
          </div>
          <button
            onClick={() => void onAddDuplicateProbe("personal-context-anchor").then(setDuplicateMessage)}
            style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(45,212,191,0.10)", border: "1px solid rgba(45,212,191,0.35)", color: "#2DD4BF", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
          >
            Test Duplicate Add
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 }}>
        {skills.map((skill) => (
          <div key={skill.id} style={{ border: "1px solid rgba(93,111,143,0.22)", background: "rgba(8,13,24,0.36)", borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ color: "#F1F4FB" }}>{skill.name}</strong>
                <div style={{ color: "#647089", fontSize: 10, marginTop: 3, wordBreak: "break-word" }}>{skill.id}</div>
              </div>
              <span style={badgeStyle(skill.enabled ? "#34D399" : "#94A3B8")}>{skill.enabled ? "Enabled" : "Disabled"}</span>
            </div>
            <div style={{ color: "#94A3B8", fontSize: 12, marginBottom: 8 }}>{skill.description}</div>
            <div style={{ color: "#D8DEEB", fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{skill.problemSolved}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {skill.ownerAgents.map((agent) => <span key={agent} style={badgeStyle(agentColor(agent))}>{agent}</span>)}
              <span style={badgeStyle(skill.safetyClass === "read_only" ? "#34D399" : skill.safetyClass === "approval_required" ? "#FBBF24" : "#F87171")}>{statusLabel(skill.safetyClass)}</span>
              <span style={badgeStyle(qualityColor(skill.skillQualityScore))}>{skill.skillQualityScore} {skill.skillQualityBand}</span>
              <span style={badgeStyle(skill.estimatedCostSaving === "high" ? "#34D399" : skill.estimatedCostSaving === "medium" ? "#60A5FA" : "#94A3B8")}>{skill.estimatedCostSaving} savings</span>
              <span style={badgeStyle(skill.validationStatus === "valid" ? "#34D399" : skill.validationStatus === "missing_metadata" ? "#FBBF24" : "#F87171")}>{statusLabel(skill.validationStatus)}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, color: "#4B5563", fontSize: 11, marginBottom: 10 }}>
              <span>{skill.source}</span>
              <span>{skill.category}</span>
              <span>{skill.dateAdded ? timeAgo(skill.dateAdded) : "date unknown"}</span>
              <span>Used {skill.usageCount}x</span>
              <span>{skill.lastUsedAt ? `Last used ${timeAgo(skill.lastUsedAt)}` : "Never used"}</span>
            </div>
            {skill.validationWarnings.length > 0 && <div style={{ color: "#FBBF24", fontSize: 11, marginBottom: 9 }}>{skill.validationWarnings.join(" ")}</div>}
            {skill.qualityWarnings.length > 0 && <div style={{ color: "#FBBF24", fontSize: 11, marginBottom: 9 }}>Quality: {skill.qualityWarnings.slice(0, 2).join(" ")}</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button onClick={() => void onSetEnabled(skill.id, !skill.enabled)} style={smallButtonStyle(skill.enabled ? "#94A3B8" : "#34D399")}>{skill.enabled ? "Disable" : "Enable"}</button>
              <button onClick={() => setOpenSkill(openSkill === skill.id ? null : skill.id)} style={smallButtonStyle("#60A5FA")}>Details</button>
              <button
                onClick={() => void onTestMatch(skill.id, matchText).then((result) => setMatchResult((prev) => ({ ...prev, [skill.id]: result })))}
                style={smallButtonStyle("#A78BFA")}
              >
                Test Match
              </button>
            </div>
            {openSkill === skill.id && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                  <SkillSignalBlock title="Strong Signals" color="#34D399" items={skill.strongSignals} />
                  <SkillSignalBlock title="When Not" color="#F87171" items={skill.whenNotToUse} />
                  <SkillSignalBlock title="Output Must Include" color="#60A5FA" items={skill.outputContract.mustInclude} />
                  <SkillSignalBlock title="Safety Rules" color="#FBBF24" items={skill.safetyRules} />
                </div>
                <div style={{ padding: 10, border: "1px solid rgba(93,111,143,0.22)", borderRadius: 8, background: "rgba(14,20,36,0.38)", color: "#94A3B8", fontSize: 11, lineHeight: 1.45 }}>
                  <div style={{ color: "#D8DEEB", fontWeight: 800, marginBottom: 4 }}>Output contract</div>
                  {skill.outputContract.format}
                </div>
                <div style={{ padding: 10, border: "1px solid rgba(93,111,143,0.22)", borderRadius: 8, background: "rgba(14,20,36,0.38)", color: "#94A3B8", fontSize: 11, lineHeight: 1.45 }}>
                  <div style={{ color: "#D8DEEB", fontWeight: 800, marginBottom: 4 }}>Eval examples</div>
                  {skill.evaluationPrompts.slice(0, 4).map((prompt) => (
                    <div key={`${skill.id}-${prompt.input}`} style={{ marginBottom: 5 }}>
                      <span style={{ color: prompt.shouldMatch ? "#34D399" : "#F87171", fontWeight: 800 }}>{prompt.shouldMatch ? "match" : "reject"}</span>
                      {" "}{prompt.input}
                    </div>
                  ))}
                </div>
                <pre style={{ maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#94A3B8", fontSize: 11, border: "1px solid rgba(93,111,143,0.22)", borderRadius: 8, padding: 10, background: "rgba(14,20,36,0.58)", margin: 0 }}>
                  {skill.instructionPreview ?? "No SKILL.md instructions found."}
                </pre>
              </div>
            )}
            {matchResult[skill.id] && (
              <div style={{ color: "#C4B5FD", fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>
                <strong>{matchResult[skill.id].matched ? "Matched" : "Rejected"}: {matchResult[skill.id].score}/100</strong>
                <div>{matchResult[skill.id].reason}</div>
                {Boolean(matchResult[skill.id].matchedSignals?.length) && <div>Signals: {matchResult[skill.id].matchedSignals?.slice(0, 5).join(", ")}</div>}
                {Boolean(matchResult[skill.id].negativeMatches?.length) && <div style={{ color: "#F87171" }}>Negative: {matchResult[skill.id].negativeMatches?.slice(0, 4).join(", ")}</div>}
              </div>
            )}
          </div>
        ))}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={matchText}
            onChange={(event) => setMatchText(event.target.value)}
            placeholder="Test a request against skill metadata"
            style={{ flex: 1, minWidth: 0, background: "rgba(14,20,36,0.72)", border: "1px solid #28324A", borderRadius: 8, padding: "9px 10px", color: "#F1F4FB", fontSize: 12, outline: "none" }}
          />
        </div>
      </div>
    </div>
  );
}

function SkillSignalBlock({ title, color, items }: { title: string; color: string; items: string[] }) {
  return (
    <div style={{ padding: 10, border: `1px solid ${color}33`, borderRadius: 8, background: `${color}0F`, minWidth: 0 }}>
      <div style={{ color, fontSize: 10, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{title}</div>
      <div style={{ display: "grid", gap: 4 }}>
        {(items.length ? items.slice(0, 5) : ["No metadata yet"]).map((item) => (
          <div key={`${title}-${item}`} style={{ color: "#D8DEEB", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{item}</div>
        ))}
      </div>
    </div>
  );
}

function miniButtonStyle(color: string): CSSProperties {
  return {
    padding: "6px 8px",
    borderRadius: 6,
    background: `${color}1F`,
    border: `1px solid ${color}66`,
    color,
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
  };
}

function SkillSummaryList({ title, skills, empty }: { title: string; skills: SkillView[]; empty: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ color: "#94A3B8", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>{title}</div>
      {skills.length === 0 ? <div style={{ color: "#647089", fontSize: 12 }}>{empty}</div> : (
        <div style={{ display: "grid", gap: 8 }}>
          {skills.map((skill) => (
            <div key={`${title}-${skill.id}`} style={{ borderRadius: 8, border: "1px solid rgba(93,111,143,0.18)", background: "rgba(8,13,24,0.32)", padding: 9 }}>
              <div style={{ color: "#F1F4FB", fontSize: 12, fontWeight: 800 }}>{skill.name}</div>
              <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 3 }}>{skill.problemSolved}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Builds panel ──────────────────────────────────────────────────────────────

function BuildsPanel({ builds }: { builds: Build[] }) {
  if (builds.length === 0) {
    return (
      <div style={{ ...cardStyle, textAlign: "center", color: "#4B5563", padding: 48 }}>
        No builds yet. Approve an engineering plan to start.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {builds.map((b) => {
        const phase1Done = ["queued", "running", "completed"].includes(b.status) && b.status !== "queued";
        const phase2Done = Boolean(b.branchName || b.pullRequestUrl);
        const phase3Done = Boolean(b.deploymentUrl);

        return (
          <div key={b.id} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#F1F4FB", fontFamily: "Fraunces, serif" }}>{b.title}</div>
              <span style={badgeStyle(statusColor(b.status))}>{statusLabel(b.status)}</span>
            </div>

            {/* Phase pipeline */}
            <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 16 }}>
              {[
                { label: "Phase 1", sub: "Inspection", done: phase1Done, active: b.status === "running" },
                { label: "Phase 2", sub: "Code", done: phase2Done, active: Boolean(b.approvalStatus === "approved" && !phase2Done) },
                { label: "Phase 3", sub: "Deploy", done: phase3Done, active: Boolean(phase2Done && !phase3Done) },
              ].map((ph, i) => (
                <div key={ph.label} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                  <div style={{ flex: 1, textAlign: "center" }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: "50%", margin: "0 auto 6px",
                      background: ph.done ? "#34D399" : ph.active ? "#A78BFA" : "#28324A",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 14, color: ph.done ? "#0E1424" : "#F1F4FB",
                      fontWeight: 700, border: ph.active ? "2px solid #A78BFA" : "none",
                    }}>
                      {ph.done ? "✓" : i + 1}
                    </div>
                    <div style={{ fontSize: 11, color: ph.done ? "#34D399" : ph.active ? "#A78BFA" : "#94A3B8", fontWeight: 600 }}>{ph.label}</div>
                    <div style={{ fontSize: 10, color: "#4B5563" }}>{ph.sub}</div>
                  </div>
                  {i < 2 && <div style={{ flex: 0.3, height: 2, background: phase1Done && i === 0 ? "#34D399" : phase2Done && i === 1 ? "#34D399" : "#28324A", margin: "-24px 0 0" }} />}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
              {b.branchName && (
                <span style={{ padding: "2px 8px", background: "rgba(40,50,74,0.5)", border: "1px solid #28324A", borderRadius: 6, color: "#94A3B8", fontFamily: "JetBrains Mono, monospace" }}>
                  {b.branchName}
                </span>
              )}
              {b.pullRequestUrl && (
                <a href={b.pullRequestUrl} target="_blank" rel="noopener" style={{ padding: "2px 10px", background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.3)", borderRadius: 6, color: "#60A5FA", textDecoration: "none" }}>
                  Pull Request
                </a>
              )}
              {b.deploymentUrl && (
                <a href={b.deploymentUrl} target="_blank" rel="noopener" style={{ padding: "2px 10px", background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)", borderRadius: 6, color: "#34D399", textDecoration: "none" }}>
                  Live
                </a>
              )}
            </div>

            {b.resultSummary && (
              <div style={{ marginTop: 12, fontSize: 12, color: "#94A3B8", padding: "8px 12px", background: "rgba(40,50,74,0.3)", borderRadius: 8 }}>
                {b.resultSummary}
              </div>
            )}
            {b.sanitizedError && (
              <div style={{ marginTop: 12, fontSize: 12, color: "#F87171", padding: "8px 12px", background: "rgba(248,113,113,0.08)", borderRadius: 8, borderLeft: "2px solid #F87171" }}>
                {b.sanitizedError}
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 11, color: "#4B5563" }}>
              {b.completedAt ? `Completed ${timeAgo(b.completedAt)}` : b.startedAt ? `Started ${timeAgo(b.startedAt)}` : `Queued ${timeAgo(b.createdAt)}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Logs panel ────────────────────────────────────────────────────────────────

function HermesNousRuntimeSection({ runtime }: { runtime: NonNullable<HealthCenterData["hermesNousRuntime"]> | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!runtime) {
    return (
      <div style={cardStyle}>
        <div style={{ color: "#F97316", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>Hermes Nous Runtime</div>
        <div style={{ color: "#647089", fontSize: 13 }}>No worker heartbeat has reported Hermes Nous runtime data yet.</div>
      </div>
    );
  }
  const statusColorValue = runtime.workerState === "online" || runtime.workerState === "busy" ? "#34D399" : runtime.workerState === "stale" ? "#FBBF24" : "#F87171";
  const copyDiagnostic = async () => {
    await navigator.clipboard.writeText(runtime.diagnostic);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const rows: Array<[string, string | null]> = [
    ["Installed", runtime.installed ? "Installed" : "Missing"],
    ["Install path", runtime.installPath ?? "missing"],
    ["Version", runtime.version ?? "unknown"],
    ["Nous auth", runtime.authState],
    ["Selected model/provider", runtime.selectedModelProvider],
    ["Worker state", runtime.workerState],
    ["Last successful run", runtime.lastSuccessfulRun ? timeAgo(runtime.lastSuccessfulRun) : "none"],
    ["Last failure", runtime.lastFailure ?? "none"],
    ["Current active run", runtime.currentActiveRun ?? "none"],
    ["Execution profiles", runtime.supportedExecutionProfiles.join(", ") || "none"],
    ["Codex fallback", runtime.codexFallbackAvailable ? "available" : "unavailable"],
  ];
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ color: "#F97316", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Hermes Nous Runtime</div>
          <div style={{ color: "#647089", fontSize: 11, marginTop: 3 }}>Safe worker heartbeat view. No browser-side auth action runs here.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={badgeStyle(statusColorValue)}>{runtime.workerState}</span>
          <button type="button" onClick={() => void copyDiagnostic()} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(249,115,22,0.42)", background: "rgba(249,115,22,0.12)", color: "#FDBA74", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
            {copied ? "Copied" : "Copy Setup Diagnostic"}
          </button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(40,50,74,0.7)", background: "rgba(11,16,32,0.28)", minWidth: 0 }}>
            <div style={{ color: "#647089", fontSize: 10, fontWeight: 800, textTransform: "uppercase" }}>{label}</div>
            <div style={{ color: "#D8DEEB", fontSize: 12, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthCenterPanel({
  data,
  busyAction,
  accountsHealth,
  accountHealthBusy,
  onAction,
  onAccountHealthCheck,
}: {
  data: HealthCenterData | null;
  busyAction: string | null;
  accountsHealth: AccountsHealthData | null;
  accountHealthBusy: boolean;
  onAction: (action: "refreshHealth" | "checkAllConnections" | "runJobScout" | "runEmailScout" | "runSkillScout" | "testApiKeys" | "testModelProviders") => Promise<void>;
  onAccountHealthCheck: () => Promise<void>;
}) {
  if (!data) return <div style={{ ...cardStyle, textAlign: "center", color: "#4B5563", padding: 48 }}>Health Center is loading.</div>;

  const actionButtons = [
    ["runJobScout", "Run Job Scout Now"],
    ["runEmailScout", "Run Email Scout Now"],
    ["runSkillScout", "Run Skill Scout Now"],
    ["checkAllConnections", "Check All Connections"],
    ["testModelProviders", "Test Provider Connections"],
    ["refreshHealth", "Refresh Health"],
  ] as const;
  const hermesExecutorReady = data.executors.some((executor) => executor.name === "Hermes Agent" && ["Ready", "Online", "Busy"].includes(executor.status));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18 }}>
        <div>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Health Center</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: statusColor(data.overall.status), display: "inline-block" }} />
            <strong style={{ color: "#F1F4FB", fontSize: 22, fontFamily: "Fraunces, serif" }}>{data.overall.message}</strong>
            <span style={badgeStyle(statusColor(data.overall.status))}>{data.overall.score}/100</span>
          </div>
          <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 8 }}>Last checked {timeAgo(data.overall.lastChecked)}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          {actionButtons.map(([action, label]) => (
            <button key={action} onClick={() => void onAction(action)} disabled={Boolean(busyAction)} style={{ padding: "8px 11px", borderRadius: 8, border: "1px solid #28324A", background: "rgba(40,50,74,0.5)", color: "#D8DEEB", cursor: busyAction ? "not-allowed" : "pointer", opacity: busyAction ? 0.55 : 1, fontSize: 12, fontWeight: 700 }}>
              {busyAction === action ? "Running..." : label}
            </button>
          ))}
        </div>
      </div>

      {data.actionResult && (
        <div style={{ ...cardStyle, borderColor: data.actionResult.ok ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)", color: data.actionResult.ok ? "#34D399" : "#F87171", fontSize: 12 }}>
          {data.actionResult.message}
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Model Providers / Council Setup</div>
            <div style={{ color: "#647089", fontSize: 11, marginTop: 4 }}>Registry for Council chat and routing preview. Automatic background routing is still preview-only.</div>
          </div>
          <div style={{ color: "#4B5563", fontSize: 11 }}>No secrets are returned to the browser.</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(245px, 1fr))", gap: 10 }}>
          {(data.apiProviders ?? []).map((provider) => {
            const color = provider.status === "working" ? "#34D399" : provider.status === "configured_untested" ? "#60A5FA" : provider.status === "missing" ? "#FBBF24" : "#F87171";
            const isCouncil = provider.council === true;
            return (
              <div key={provider.provider} style={{ padding: "12px", background: isCouncil ? "rgba(14,20,36,0.58)" : "rgba(40,50,74,0.3)", border: `1px solid ${isCouncil ? "rgba(96,165,250,0.28)" : "#28324A"}`, borderRadius: 8, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", marginBottom: 9 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 800, overflowWrap: "anywhere" }}>{provider.provider}</div>
                    <div style={{ color: isCouncil ? "#60A5FA" : "#647089", fontSize: 10, fontWeight: 800, marginTop: 3, textTransform: "uppercase" }}>{provider.roleLabel ?? "Project service"}</div>
                  </div>
                  <span style={badgeStyle(color)}>{statusLabel(provider.status)}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "76px minmax(0,1fr)", gap: "6px 10px", color: "#94A3B8", fontSize: 11 }}>
                  <span style={{ color: "#647089" }}>Configured</span>
                  <strong style={{ color: provider.configured ? "#34D399" : "#FBBF24" }}>{provider.configured ? "Yes" : "No"}</strong>
                  <span style={{ color: "#647089" }}>Model</span>
                  <span style={{ color: "#D8DEEB", overflowWrap: "anywhere" }}>{provider.selectedModel ?? "default"}</span>
                  <span style={{ color: "#647089" }}>Env</span>
                  <span>{provider.environment ?? provider.source}</span>
                  <span style={{ color: "#647089" }}>Test</span>
                  <span>{provider.testable === false ? "Deferred" : provider.lastTested ? timeAgo(provider.lastTested) : "not tested"}</span>
                </div>
                {provider.requiredEnvVars.length > 0 && <div style={{ color: "#647089", fontSize: 10, marginTop: 9, overflowWrap: "anywhere" }}>{provider.requiredEnvVars.join(", ")}</div>}
                {provider.routePreview && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 9, lineHeight: 1.45 }}>{provider.routePreview}</div>}
                {provider.safeError && <div style={{ color: provider.status === "missing" ? "#FBBF24" : provider.status === "configured_untested" ? "#60A5FA" : "#F87171", fontSize: 11, marginTop: 8, overflowWrap: "anywhere" }}>{provider.safeError}</div>}
              </div>
            );
          })}
          {!(data.apiProviders ?? []).length && <div style={{ color: "#4B5563", fontSize: 13 }}>API provider health has not been loaded yet.</div>}
        </div>
      </div>

      <HermesNousRuntimeSection runtime={data.hermesNousRuntime} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Connected Accounts</div>
              <div style={{ color: "#647089", fontSize: 11, marginTop: 4 }}>
                Session: <strong style={{ color: "#D8DEEB" }}>{accountsHealth?.currentSession.email ?? accountsHealth?.currentSession.name ?? "unknown"}</strong>
              </div>
            </div>
            <button
              onClick={() => void onAccountHealthCheck()}
              disabled={accountHealthBusy}
              style={{ ...miniButtonStyle("#60A5FA"), opacity: accountHealthBusy ? 0.6 : 1 }}
            >
              {accountHealthBusy ? "Testing..." : "Test connection"}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(accountsHealth?.accounts.length ? accountsHealth.accounts : data.accounts.map((account, index): AccountsHealthData["accounts"][number] => ({
              id: account.email ?? account.name ?? `account-${index}`,
              email: account.email ?? account.name,
              label: account.label ?? account.name,
              isDefault: index === 0,
              scopes: "",
              gmailScope: Boolean(account.gmailScope),
              calendarScope: Boolean(account.calendarScope),
              createdAt: "",
              tokenExpiresAt: account.tokenExpiresAt ?? "",
              lastSyncedAt: account.lastSuccessfulSync,
              lastSyncStatus: account.connected ? "ok" : null,
              lastError: account.lastError,
              health: account.connected && !account.lastError ? "connected" : account.reconnectRequired ? "disconnected" : "unknown",
              reconnectRequired: account.reconnectRequired,
            }))).map((account) => {
              const color = account.health === "connected" ? "#34D399" : account.health === "expiring_soon" || account.health === "unknown" ? "#FBBF24" : "#F87171";
              const healthLabel = account.health === "expiring_soon" ? "Needs test" : account.health.replace("_", " ");
              return (
                <div key={account.id} style={{ padding: "11px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid #28324A", borderRadius: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ color: "#F1F4FB", fontSize: 13, overflowWrap: "anywhere" }}>{account.email}</strong>
                      <div style={{ color: "#647089", fontSize: 10, marginTop: 2 }}>
                        {account.label}{account.isDefault ? " / default" : ""}
                      </div>
                    </div>
                    <span style={badgeStyle(color)}>{healthLabel}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 8, color: "#94A3B8", fontSize: 11 }}>
                    <span>Gmail Scope: <strong style={{ color: account.gmailScope ? "#34D399" : "#FBBF24" }}>{account.gmailScope ? "yes" : "no"}</strong></span>
                    <span>Calendar Scope: <strong style={{ color: account.calendarScope ? "#34D399" : "#FBBF24" }}>{account.calendarScope ? "yes" : "no"}</strong></span>
                    <span>Token Expires: {account.tokenExpiresAt ? relativeTime(account.tokenExpiresAt) : "unknown"}</span>
                    <span>Last Sync: {account.lastSyncedAt ? timeAgo(account.lastSyncedAt) : "Never"}</span>
                    <span>Reconnect Required: {account.reconnectRequired ? "yes" : "no"}</span>
                    <span>Status: {account.lastSyncStatus ?? "untested"}</span>
                    <span style={{ color: account.lastError ? "#F87171" : "#94A3B8", gridColumn: "1 / -1" }}>Last Error: {account.lastError ?? "none"}</span>
                  </div>
                  {account.reconnectRequired && (
                    <a href={`/api/accounts/link?label=${encodeURIComponent(account.label ?? "Other")}`} style={{ display: "inline-block", marginTop: 9, color: "#60A5FA", fontSize: 11, fontWeight: 800, textDecoration: "none" }}>
                      Reconnect Google account
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>Scheduled Jobs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.scheduledJobs.map((job) => (
              <div key={job.key} style={{ padding: "11px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid #28324A", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <strong style={{ color: "#F1F4FB", fontSize: 13 }}>{job.name}</strong>
                  <span style={badgeStyle(statusColor(job.status))}>{job.status}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, color: "#94A3B8", fontSize: 11 }}>
                  <span>{job.enabled ? "Enabled" : "Disabled"}</span>
                  <span>Runtime: {job.runtime ?? "unknown"}</span>
                  <span>Last Run: {job.lastRun ? timeAgo(job.lastRun) : "Never"}</span>
                  <span>Next Run: {job.nextRun ?? "unknown"}</span>
                  <span>Success: {job.successCount}</span>
                  <span>Failure: {job.failureCount}</span>
                </div>
                <div style={{ color: job.status === "Failed" ? "#F87171" : "#94A3B8", fontSize: 11, marginTop: 7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.lastResult ?? "No result recorded."}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
        <div style={cardStyle}>
          <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>Executor Health</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.executors.map((executor) => {
              const warningOnly = executor.name === "Codex Executor" && executor.status === "Offline" && hermesExecutorReady;
              return (
              <div key={executor.name} style={{ padding: "11px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid #28324A", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <strong style={{ color: "#F1F4FB", fontSize: 13 }}>{executor.name}</strong>
                  <span style={badgeStyle(statusColor(warningOnly ? "warning" : executor.status))}>{warningOnly ? "Offline — optional" : executor.status}</span>
                </div>
                <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 8 }}>Last Run: {executor.lastRun ? timeAgo(executor.lastRun) : "Never"}</div>
                {executor.machineName && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 4 }}>Machine: {executor.machineName}</div>}
                {executor.currentTask && <div style={{ color: "#60A5FA", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>Current Task: {executor.currentTask}</div>}
                {executor.rootPath && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>Root: <code>{executor.rootPath}</code></div>}
                {executor.workerApiTarget && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>Worker API Target: <code>{executor.workerApiTarget}</code></div>}
                {executor.name === "Local Worker" && <div style={{ color: executor.lastFetchError ? "#F87171" : "#94A3B8", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>Last Fetch Error: {executor.lastFetchError ?? "none"}</div>}
                {executor.capabilities?.length ? <div style={{ color: "#647089", fontSize: 10, marginTop: 4 }}>{executor.capabilities.join(" / ")}</div> : null}
                <div style={{ color: executor.lastError ? warningOnly ? "#FBBF24" : "#F87171" : "#94A3B8", fontSize: 11, marginTop: 4 }}>Last Error: {executor.lastError ?? "none"}</div>
              </div>
              );
            })}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>Notification Health</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.notifications.map((notification) => (
              <div key={notification.name} style={{ padding: "11px 12px", background: "rgba(40,50,74,0.35)", border: "1px solid #28324A", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <strong style={{ color: "#F1F4FB", fontSize: 13 }}>{notification.name}</strong>
                  <span style={badgeStyle(statusColor(notification.status))}>{notification.status}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8, color: "#94A3B8", fontSize: 11 }}>
                  <span>Last Sent: {notification.lastSent ? timeAgo(notification.lastSent) : "Never"}</span>
                  <span style={{ color: notification.lastFailed ? "#F87171" : "#94A3B8" }}>Last Failed: {notification.lastFailed ? timeAgo(notification.lastFailed) : "none"}</span>
                  <span>Pending Notifications: {notification.pendingNotifications}</span>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, color: "#94A3B8", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Health Logs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, maxHeight: 220, overflow: "auto" }}>
            {data.logs.length ? data.logs.slice(0, 12).map((log) => (
              <div key={`${log.timestamp}-${log.component}-${log.message}`} style={{ display: "grid", gridTemplateColumns: "90px 88px minmax(0,1fr)", gap: 8, color: "#94A3B8", fontSize: 11 }}>
                <span>{timeAgo(log.timestamp)}</span>
                <span style={{ color: statusColor(log.status) }}>{log.component}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.message}</span>
              </div>
            )) : <div style={{ color: "#4B5563", fontSize: 12 }}>No health checks logged yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function LogsPanel({ runs, audit }: { runs: AgentRun[]; audit: AuditEntry[] }) {
  const merged = [
    ...runs.map((r) => ({ ...r, _type: "run" as const })),
    ...audit.map((a) => ({ ...a, _type: "audit" as const })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (merged.length === 0) {
    return <div style={{ ...cardStyle, textAlign: "center", color: "#4B5563", padding: 48 }}>No activity yet.</div>;
  }

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        Agent Activity
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {merged.slice(0, 60).map((entry, i) => {
          if (entry._type === "run") {
            const r = entry as AgentRun & { _type: "run" };
            const color = agentColor(r.agentName);
            return (
              <div key={r.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < merged.length - 1 ? "1px solid rgba(40,50,74,0.5)" : "none" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${color}20`, border: `1px solid ${color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color, fontWeight: 700, flexShrink: 0 }}>
                  {r.agentName.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color }}>{r.agentName}</span>
                    <span style={badgeStyle(r.status === "completed" ? "#34D399" : "#F87171")}>{r.status}</span>
                    {r.modelProvider && <span style={{ fontSize: 10, color: "#4B5563" }}>{r.modelProvider}</span>}
                  </div>
                  {r.inputSummary && <div style={{ fontSize: 12, color: "#94A3B8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>In: {r.inputSummary}</div>}
                  {r.outputSummary && <div style={{ fontSize: 12, color: "#F1F4FB", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Out: {r.outputSummary}</div>}
                </div>
                <div style={{ fontSize: 11, color: "#4B5563", flexShrink: 0 }}>{timeAgo(r.createdAt)}</div>
              </div>
            );
          }

          const a = entry as AuditEntry & { _type: "audit" };
          const actionColor = a.action === "approved" ? "#34D399" : a.action === "rejected" ? "#F87171" : "#60A5FA";
          return (
            <div key={a.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: i < merged.length - 1 ? "1px solid rgba(40,50,74,0.5)" : "none" }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${actionColor}15`, border: `1px solid ${actionColor}30`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: actionColor, flexShrink: 0 }}>
                {a.action === "approved" ? "✓" : a.action === "rejected" ? "✗" : "~"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: actionColor, fontWeight: 600, marginBottom: 2 }}>{a.action} {a.resourceType}</div>
                {a.detail && <div style={{ fontSize: 12, color: "#94A3B8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.detail}</div>}
              </div>
              <div style={{ fontSize: 11, color: "#4B5563", flexShrink: 0 }}>{timeAgo(a.createdAt)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function AgentBusPanel({ data }: { data: AgentBusData | null }) {
  const envelopes = data?.envelopes ?? [];
  const pending = envelopes.filter((envelope) => envelope.status === "pending");
  const recent = envelopes.slice(0, 18);
  const payloadPreview = (payload: unknown) => {
    if (typeof payload === "string") return payload.slice(0, 420);
    return JSON.stringify(payload, null, 2).slice(0, 420);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Agent Bus</div>
            <h2 style={{ fontSize: 24, margin: 0, fontFamily: "Fraunces, serif" }}>Envelope Traffic</h2>
          </div>
          <div style={{ color: "#647089", fontSize: 12 }}>{data?.lastUpdated ? `Updated ${timeAgo(data.lastUpdated)}` : "Loading"}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {[
            ["Pending", data?.counts.pending ?? 0, "#FBBF24"],
            ["Consumed", data?.counts.consumed ?? 0, "#34D399"],
            ["Expired", data?.counts.expired ?? 0, "#94A3B8"],
            ["Recent", envelopes.length, "#60A5FA"],
          ].map(([label, value, color]) => (
            <div key={String(label)} style={{ border: "1px solid rgba(148,163,184,0.16)", borderRadius: 8, padding: "10px 12px", background: "rgba(15,23,42,0.45)" }}>
              <div style={{ color: String(color), fontSize: 22, fontWeight: 850 }}>{value}</div>
              <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <MemoryList
          title="Pending Handoffs"
          empty="No pending envelopes"
          items={pending.map((envelope) => ({
            key: envelope.id,
            head: `${envelope.fromAgent} -> ${envelope.toAgent ?? "any"}`,
            body: payloadPreview(envelope.payload),
            meta: `${envelope.envelopeType} / expires ${timeAgo(envelope.expiresAt)}`,
          }))}
        />
        <MemoryList
          title="Recent Envelopes"
          empty="No agent envelopes yet"
          items={recent.map((envelope) => ({
            key: envelope.id,
            head: `${envelope.fromAgent} -> ${envelope.toAgent ?? "any"} [${statusLabel(envelope.status)}]`,
            body: payloadPreview(envelope.payload),
            meta: `${envelope.envelopeType} / ${timeAgo(envelope.createdAt)}${envelope.consumedAt ? ` / consumed ${timeAgo(envelope.consumedAt)}` : ""}`,
          }))}
        />
      </div>
    </div>
  );
}

function ChatPanel({ initialMessages }: { initialMessages: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    if (!overrideText) setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: `tmp-${Date.now()}`, role: "user", content: text, channel: "dashboard", createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      if (res.ok) {
        const data = await res.json() as { reply?: { content?: string; quickActions?: ChatQuickAction[] }; userMessage?: { id?: string } };
        if (data.reply?.content) {
          const assistantMsg: ChatMessage = { id: `reply-${Date.now()}`, role: "assistant", content: data.reply.content, quickActions: data.reply.quickActions, channel: "dashboard", createdAt: new Date().toISOString() };
          setMessages((prev) => [...prev, assistantMsg]);
        }
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", height: "calc(100vh - 280px)", minHeight: 400 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        Unified Chat
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#4B5563", padding: 32, fontSize: 13 }}>
            No messages yet. Say something to Hermes.
          </div>
        )}
        {messages.map((m) => {
          const isUser = m.role === "user";
          const channelLabel = m.channel === "telegram" ? "TG" : "WEB";
          const channelColor = m.channel === "telegram" ? "#60A5FA" : "#A78BFA";
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: isUser ? "row-reverse" : "row", gap: 10, alignItems: "flex-end" }}>
              {!isUser && (
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#A78BFA", fontWeight: 700, flexShrink: 0 }}>
                  H
                </div>
              )}
              <div style={{ maxWidth: "75%" }}>
                <div style={{
                  padding: "10px 14px",
                  borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: isUser ? "rgba(167,139,250,0.15)" : "rgba(40,50,74,0.5)",
                  border: `1px solid ${isUser ? "rgba(167,139,250,0.25)" : "#28324A"}`,
                  fontSize: 13,
                  color: "#F1F4FB",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {m.content}
                </div>
                {!isUser && m.quickActions?.length ? (
                  <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
                    {m.quickActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={sending}
                        onClick={() => void send(action.value)}
                        title={action.description}
                        style={{ textAlign: "left", borderRadius: 8, border: "1px solid rgba(52,211,153,0.36)", background: "rgba(52,211,153,0.12)", color: "#34D399", padding: "8px 10px", cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.65 : 1 }}
                      >
                        <span style={{ display: "block", fontSize: 12, fontWeight: 800 }}>{action.label}</span>
                        {action.description && <span style={{ display: "block", marginTop: 3, color: "#94A3B8", fontSize: 11, lineHeight: 1.35 }}>{action.description}</span>}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div style={{ fontSize: 10, color: "#4B5563", marginTop: 4, display: "flex", gap: 6, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                  <span style={{ color: channelColor, fontWeight: 600 }}>{channelLabel}</span>
                  <span>{timeAgo(m.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
          disabled={sending}
          placeholder="Message Hermes... (Ctrl/Cmd + Enter to send)"
          rows={2}
          style={{
            flex: 1, background: "rgba(14,20,36,0.6)", border: "1px solid #28324A", borderRadius: 12, padding: "10px 14px",
            color: "#F1F4FB", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit", opacity: sending ? 0.7 : 1,
          }}
        />
        <button
          type="submit"
          disabled={sending}
          style={{
            padding: "0 20px", borderRadius: 12, background: "rgba(167,139,250,0.15)",
            border: "1px solid rgba(167,139,250,0.3)", color: "#A78BFA", fontWeight: 600,
            fontSize: 13, cursor: sending ? "not-allowed" : "pointer",
            opacity: sending ? 0.5 : 1,
          }}
        >
          {sending ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CommandCenterClient() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedOffice, setSelectedOffice] = useState<AgentOffice>("hermes");
  const [agentsView, setAgentsView] = useState<"talk" | "offices">("talk");
  const [projects, setProjects] = useState<Project[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [approvals, setApprovals] = useState<ApprovalAction[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [memoryOffice, setMemoryOffice] = useState<MemoryOfficeData | null>(null);
  const [memoryContextDebug, setMemoryContextDebug] = useState<MemoryContextDebugData | null>(null);
  const [executionQueue, setExecutionQueue] = useState<ExecutionQueueData | null>(null);
  const [executionRuns, setExecutionRuns] = useState<ExecutionRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [executionEvents, setExecutionEvents] = useState<ExecutionTraceEvent[]>([]);
  const [healthCenter, setHealthCenter] = useState<HealthCenterData | null>(null);
  const [accountsHealth, setAccountsHealth] = useState<AccountsHealthData | null>(null);
  const [agentBus, setAgentBus] = useState<AgentBusData | null>(null);
  const [healthAction, setHealthAction] = useState<string | null>(null);
  const [accountHealthAction, setAccountHealthAction] = useState(false);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [skillRegistry, setSkillRegistry] = useState<SkillRegistryData | null>(null);
  const [skillScoutResult, setSkillScoutResult] = useState<SkillScoutResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [projRes, buildsRes, approvalsRes, logsRes, chatRes, memoryRes, memoryDebugRes, skillsRes, queueRes, runRes, healthRes, accountsRes, busRes] = await Promise.allSettled([
        fetch("/api/command-center/projects").then((r) => r.json() as Promise<{ projects: Project[] }>),
        fetch("/api/command-center/builds").then((r) => r.json() as Promise<{ builds: Build[] }>),
        fetch("/api/approvals").then((r) => r.json() as Promise<{ actions: ApprovalAction[] }>),
        fetch("/api/command-center/logs").then((r) => r.json() as Promise<{ runs: AgentRun[]; audit: AuditEntry[] }>),
        fetch("/api/chat").then((r) => r.json() as Promise<{ messages: ChatMessage[] }>),
        fetch("/api/command-center/memory-office").then((r) => r.json() as Promise<MemoryOfficeData>),
        fetch("/api/command-center/memory-context-debug").then((r) => r.json() as Promise<MemoryContextDebugData>),
        fetch("/api/command-center/skills").then((r) => r.json() as Promise<{ skills: SkillView[]; registry: SkillRegistryData }>),
        fetch("/api/command-center/execution-queue").then((r) => r.json() as Promise<ExecutionQueueData>),
        fetch("/api/command-center/runs").then((r) => r.json() as Promise<ExecutionRunsData>),
        fetch("/api/command-center/health-center").then((r) => r.json() as Promise<HealthCenterData>),
        fetch("/api/accounts").then((r) => r.json() as Promise<AccountsHealthData>),
        fetch("/api/command-center/agent-bus").then((r) => r.json() as Promise<AgentBusData>),
      ]);

      if (projRes.status === "fulfilled") setProjects(projRes.value.projects ?? []);
      if (buildsRes.status === "fulfilled") setBuilds(buildsRes.value.builds ?? []);
      if (approvalsRes.status === "fulfilled") setApprovals(approvalsRes.value.actions ?? []);
      if (logsRes.status === "fulfilled") {
        setRuns(logsRes.value.runs ?? []);
        setAudit(logsRes.value.audit ?? []);
      }
      if (memoryRes.status === "fulfilled" && !("error" in memoryRes.value)) setMemoryOffice(memoryRes.value);
      if (memoryDebugRes.status === "fulfilled" && !("error" in memoryDebugRes.value)) setMemoryContextDebug(memoryDebugRes.value);
      if (skillsRes.status === "fulfilled") {
        setSkills(skillsRes.value.skills ?? []);
        setSkillRegistry(skillsRes.value.registry ?? null);
      }
      if (queueRes.status === "fulfilled" && !("error" in queueRes.value)) setExecutionQueue(queueRes.value);
      if (runRes.status === "fulfilled" && !("error" in runRes.value)) {
        const nextRuns = runRes.value.runs ?? [];
        setExecutionRuns(nextRuns);
        setSelectedRunId((current) => current && nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id ?? null);
      }
      if (healthRes.status === "fulfilled" && !("error" in healthRes.value)) setHealthCenter(healthRes.value);
      if (accountsRes.status === "fulfilled" && !("error" in accountsRes.value)) setAccountsHealth(accountsRes.value);
      if (busRes.status === "fulfilled" && !("error" in busRes.value)) setAgentBus(busRes.value);

      const webMsgs = chatRes.status === "fulfilled" ? (chatRes.value.messages ?? []).map((m) => ({ ...m, channel: "dashboard" })) : [];
      setChatMessages(webMsgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
    const interval = setInterval(() => { void fetchAll(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  useEffect(() => {
    if (!selectedRunId) {
      setExecutionEvents([]);
      return;
    }
    let cancelled = false;
    const fetchEvents = async () => {
      const res = await fetch(`/api/command-center/runs/${selectedRunId}/events`);
      if (!res.ok) return;
      const data = await res.json() as { events?: ExecutionTraceEvent[] };
      if (!cancelled) setExecutionEvents(data.events ?? []);
    };
    void fetchEvents();
    const interval = setInterval(() => { void fetchEvents(); }, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedRunId]);

  const handleApprove = async (id: string) => {
    await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    void fetchAll();
  };

  const handleReject = async (id: string) => {
    await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject" }) });
    void fetchAll();
  };

  const runAction = async (runId: string, action: "cancel" | "retry") => {
    await fetch(`/api/command-center/runs/${runId}/${action}`, { method: "POST" });
    await fetchAll();
  };

  const fallbackToCodex = async (runId: string) => {
    if (!window.confirm("Switch this run to Codex CLI? This queues a separate fallback run and will not deploy, push, or touch production.")) return;
    await fetch(`/api/command-center/runs/${runId}/fallback-to-codex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "switch-to-codex" }),
    });
    await fetchAll();
  };

  const copyDiagnostic = async (run: ExecutionRun, events: ExecutionTraceEvent[]) => {
    await navigator.clipboard.writeText(JSON.stringify({ run, events: events.slice(-40) }, null, 2));
  };

  const pendingCount = approvals.filter((a) => a.status === "pending").length;
  const systemHealth = calculateSystemHealthScore(healthCenter, executionQueue);

  const createTestMemory = async () => {
    await fetch("/api/command-center/memory-office", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "createTestMemory" }),
    });
    await fetchAll();
  };

  const memoryCenterAction = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/command-center/memory-office", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error ?? "Memory action failed.");
    }
    await fetchAll();
  };

  const scoutRepo = async (repoUrl: string) => {
    const res = await fetch("/api/command-center/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scoutRepo", repoUrl }),
    });
    if (res.ok) {
      const data = await res.json() as { result: SkillScoutResult };
      setSkillScoutResult(data.result);
    } else {
      const data = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error ?? "Skill Scout failed.");
    }
    await fetchAll();
  };

  const refreshSkills = async () => {
    const res = await fetch("/api/command-center/skills?refresh=1");
    const data = await res.json() as { skills?: SkillView[]; registry?: SkillRegistryData };
    setSkills(data.skills ?? []);
    setSkillRegistry(data.registry ?? null);
  };

  const setSkillEnabledAction = async (skillId: string, enabled: boolean) => {
    const res = await fetch("/api/command-center/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setEnabled", skillId, enabled }),
    });
    if (!res.ok) throw new Error("Skill toggle failed.");
    await refreshSkills();
  };

  const testSkillMatchAction = async (skillId: string, message: string) => {
    const res = await fetch("/api/command-center/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "testMatch", skillId, message }),
    });
    const data = await res.json() as { result?: SkillTestResult; error?: string };
    if (!res.ok || !data.result) throw new Error(data.error ?? "Skill match failed.");
    await refreshSkills();
    return data.result;
  };

  const duplicateSkillProbe = async (candidateName: string) => {
    const res = await fetch("/api/command-center/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "addSkill", candidateName }),
    });
    const data = await res.json() as { message?: string };
    await refreshSkills();
    return data.message ?? "Duplicate check completed.";
  };

  const runHealthAction = async (action: "refreshHealth" | "checkAllConnections" | "runJobScout" | "runEmailScout" | "runSkillScout" | "testApiKeys" | "testModelProviders") => {
    setHealthAction(action);
    try {
      const res = await fetch("/api/command-center/health-center", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null) as HealthCenterData | null;
      if (data && !("error" in data)) setHealthCenter(data);
    } finally {
      setHealthAction(null);
      void fetchAll();
    }
  };

  const runAccountHealthCheck = async () => {
    setAccountHealthAction(true);
    try {
      const res = await fetch("/api/accounts/health-check", { method: "POST" });
      const data = await res.json().catch(() => null) as AccountsHealthData | null;
      if (res.ok && data && !("error" in data)) setAccountsHealth(data);
    } finally {
      setAccountHealthAction(false);
      void fetchAll();
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--cc-bg-page, #0E1424)", color: "var(--cc-fg-primary, #F1F4FB)", fontFamily: "Hanken Grotesk, sans-serif" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #28324A", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 42 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/" style={{ fontSize: 11, color: "#94A3B8", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
            <span>←</span> Dashboard
          </a>
          <div style={{ width: 1, height: 16, background: "#28324A" }} />
          <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "Fraunces, serif", color: "#D8DEEB" }}>
            Mission Control
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#4B5563" }}>
          {loading && <span>Syncing...</span>}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(healthCenter?.overall.status ?? "healthy"), animation: "pulse 2s infinite" }} />
          <span>{healthCenter ? `Health: ${systemHealth.score}%` : "Live"}</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: "0 24px", borderBottom: "1px solid #28324A", display: "flex", gap: 6, minHeight: 38, alignItems: "center", overflowX: "auto" }}>
        {(["overview", "health", "agents", "memory", "skills", "projects", "builds", "runs", "bus", "logs", "chat"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={pillStyle(tab === t)}>
            {t === "health" ? "Health Center" : t === "runs" ? "Run Inspector" : t === "bus" ? "Agent Bus" : t.charAt(0).toUpperCase() + t.slice(1)}
            {t === "overview" && pendingCount > 0 && (
              <span style={{ marginLeft: 6, background: "#FBBF24", color: "#0E1424", borderRadius: 999, padding: "0 5px", fontSize: 10, fontWeight: 800 }}>
                {pendingCount}
              </span>
            )}
            {t === "health" && healthCenter?.overall.status !== "healthy" && (
              <span style={{ marginLeft: 6, background: statusColor(healthCenter?.overall.status ?? "warning"), color: "#0E1424", borderRadius: 999, padding: "0 5px", fontSize: 10, fontWeight: 800 }}>
                {healthCenter?.overall.status === "failure" ? "!" : "?"}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "12px 24px 28px", maxWidth: tab === "overview" ? 1560 : 1100, margin: "0 auto" }}>
        {loading && projects.length === 0 ? (
          <div style={{ textAlign: "center", color: "#4B5563", padding: 64 }}>Loading...</div>
        ) : (
          <>
            {tab === "overview" && (
              <OverviewPanel
                projects={projects}
                approvals={approvals}
                builds={builds}
                queue={executionQueue}
                runs={runs}
                health={healthCenter}
                memoryDebug={memoryContextDebug}
                skills={skills}
                chatMessages={chatMessages}
                onApprove={handleApprove}
                onReject={handleReject}
                onTabSwitch={setTab}
                onOfficeSelect={(office) => { setSelectedOffice(office); setAgentsView("offices"); }}
              />
            )}
            {tab === "health" && (
              <HealthCenterPanel
                data={healthCenter}
                busyAction={healthAction}
                accountsHealth={accountsHealth}
                accountHealthBusy={accountHealthAction}
                onAction={runHealthAction}
                onAccountHealthCheck={runAccountHealthCheck}
              />
            )}
            {tab === "agents" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["talk", "offices"] as const).map((view) => (
                    <button
                      key={view}
                      onClick={() => setAgentsView(view)}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 8,
                        border: agentsView === view ? "1px solid rgba(167,139,250,0.5)" : "1px solid rgba(93,111,143,0.25)",
                        background: agentsView === view ? "rgba(167,139,250,0.14)" : "rgba(8,13,24,0.38)",
                        color: agentsView === view ? "#C4B5FD" : "#94A3B8",
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      {view === "talk" ? "Talk" : "Offices"}
                    </button>
                  ))}
                </div>
                {agentsView === "talk" ? (
                  <AgentTalkPanel />
                ) : (
                  <AgentOfficesPanel
                    selectedOffice={selectedOffice}
                    onOfficeSelect={setSelectedOffice}
                    projects={projects}
                    builds={builds}
                    approvals={approvals}
                    queue={executionQueue}
                    runs={runs}
                    memoryOffice={memoryOffice}
                    memoryDebug={memoryContextDebug}
                  />
                )}
              </div>
            )}
            {tab === "memory" && <MemoryOfficePanel data={memoryOffice} debug={memoryContextDebug} onCreateTestMemory={createTestMemory} onMemoryAction={memoryCenterAction} />}
            {tab === "skills" && (
              <SkillsPanel
                skills={skills}
                registry={skillRegistry}
                scoutResult={skillScoutResult}
                approvals={approvals}
                onScout={scoutRepo}
                onRefresh={refreshSkills}
                onSetEnabled={setSkillEnabledAction}
                onTestMatch={testSkillMatchAction}
                onAddDuplicateProbe={duplicateSkillProbe}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            )}
            {tab === "projects" && <ProjectsPanel projects={projects} />}
            {tab === "builds" && <BuildsPanel builds={builds} />}
            {tab === "runs" && (
              <RunInspectorPanel
                runs={executionRuns}
                selectedRunId={selectedRunId}
                events={executionEvents}
                onSelect={setSelectedRunId}
                onCancel={(runId) => runAction(runId, "cancel")}
                onRetry={(runId) => runAction(runId, "retry")}
                onFallback={fallbackToCodex}
                onCopyDiagnostic={copyDiagnostic}
              />
            )}
            {tab === "bus" && <AgentBusPanel data={agentBus} />}
            {tab === "logs" && <LogsPanel runs={runs} audit={audit} />}
            {tab === "chat" && <ChatPanel initialMessages={chatMessages} />}
          </>
        )}
      </div>
    </div>
  );
}
