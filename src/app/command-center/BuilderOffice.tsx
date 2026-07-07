"use client";

import { useCallback, useEffect, useState } from "react";
import ProjectInspector from "./ProjectInspector";
import { diagnoseBuildFailure } from "@/lib/build-failure-diagnostics";
import { redactBuildText } from "@/lib/live-build-console";

type Artifact = { type: string; title: string; url?: string; content?: string; metadata?: Record<string, unknown> };
type QaItem = { key: string; label: string; status: "passed" | "failed" | "skipped"; detail: string };
type FuguGateReview = {
  verdict?: "pass" | "revise" | "unavailable" | "error";
  score?: number | null;
  threshold?: number;
  summary?: string;
  mustFixBeforeBuild?: string[];
};
type Project = {
  id: string;
  projectName: string;
  route: string | null;
  localFolderPath: string | null;
  status: string;
  createdAt: string;
  currentTask: string | null;
  buildLog?: string | null;
  buildError?: string | null;
  localDevUrl?: string | null;
  localDevPid?: number | null;
  previewStatus?: "online" | "offline" | "stale" | null;
  researchBrief?: string | null;
  designReview?: string | null;
  polishReview?: string | null;
  designScore?: number | null;
  fuguGateStatus?: "pass" | "revise" | "unavailable" | "error" | null;
  fuguGateScore?: number | null;
  fuguGateReview?: FuguGateReview | null;
  fuguGateReviewedAt?: string | null;
  fuguGateOverrideReason?: string | null;
  fuguPolishStatus?: string | null;
  qaStatus?: string | null;
  qaChecklist?: QaItem[] | null;
  taskCounts: { done: number; total: number };
};
type ExecutionResult = {
  status: string;
  answer: string;
  artifacts: Artifact[];
  project?: Project;
  toolCalls: Array<{ tool: string; status: string; error?: string }>;
};
type Build = { id: string; title: string; status: string; resultSummary: string | null; implementationSummary: string | null; branchName: string | null; commitSha: string | null; deploymentUrl: string | null; sanitizedError: string | null };
type Run = { id: string; agentName: string; outputSummary: string | null; status: string };
type RootInfo = { root: string; exists: boolean; projectCount: number; warning: string | null };
type CodexStatus = { installed: boolean; available: boolean; version: string | null; message: string };
type ProviderStatus = { provider: string; configured: boolean; status: "working" | "missing" | "invalid" | "error" | "configured_untested"; safeError: string | null };
type ExecutorStatus = { name: string; status: "Ready" | "Online" | "Offline" | "Stale" | "Busy" | "Unknown"; lastError: string | null };
type BuilderHealth = { apiProviders: ProviderStatus[]; executors: ExecutorStatus[] };

const card: React.CSSProperties = { background: "rgba(26,35,54,.85)", border: "1px solid #28324A", borderRadius: 16, padding: "20px 24px", backdropFilter: "blur(12px)" };

function badge(status: string): React.CSSProperties {
  const color = ["completed", "done", "deployed", "qa_passed", "Ready to Build", "Brief Ready", "Dev Server Running", "ready_to_build"].includes(status) ? "#34D399" : ["failed", "blocked", "qa_failed", "Build Failed"].includes(status) ? "#F87171" : ["ready", "qa_pending", "Dev Server Stopped"].includes(status) ? "#60A5FA" : "#A78BFA";
  return { display: "inline-block", color, background: `${color}18`, border: `1px solid ${color}45`, borderRadius: 999, padding: "3px 9px", fontSize: 11, fontWeight: 700 };
}

function qaColor(status: QaItem["status"]): string {
  if (status === "passed") return "#34D399";
  if (status === "failed") return "#F87171";
  return "#94A3B8";
}

type QaSummary = {
  build: "passed" | "failed";
  functional: "passed" | "failed" | "needs review";
  polish: "pending" | "recommended" | "completed";
  accessibility: "passed" | "needs review" | "failed";
  pendingMessage: string | null;
};

function summarizeQa(project: Project): QaSummary {
  const checklist = project.qaChecklist ?? [];
  const byKeys = (keys: string[]) => checklist.filter((item) => keys.includes(item.key));
  const buildPassed = /Building:\s*passed|Rebuild:\s*passed/i.test(project.buildLog ?? "") || ["qa_pending", "qa_failed", "qa_passed", "completed"].includes(project.status);
  const functionalItems = byKeys(["homepage_loads", "navigation_works", "primary_buttons_clickable", "interactions_work", "local_storage_works", "no_empty_dead_sections"]);
  const accessibilityItems = byKeys(["semantic_html", "button_accessible_names", "form_labels", "keyboard_navigation", "focus_states", "contrast"]);
  const criticalFunctionalFailure = functionalItems.some((item) => ["homepage_loads", "primary_buttons_clickable"].includes(item.key) && item.status === "failed");
  const functionalNeedsReview = functionalItems.some((item) => item.status === "failed");
  const criticalAccessibilityFailure = accessibilityItems.some((item) => ["semantic_html", "keyboard_navigation", "contrast"].includes(item.key) && item.status === "failed");
  const accessibilityNeedsReview = accessibilityItems.some((item) => item.status === "failed");
  const polishItem = checklist.find((item) => item.key === "polish_review_completed");
  const responsiveItem = checklist.find((item) => item.key === "mobile_layout_reviewed");
  const pending = project.qaStatus === "qa_pending" || (buildPassed && project.qaStatus === "qa_failed");
  return {
    build: buildPassed ? "passed" : "failed",
    functional: criticalFunctionalFailure ? "failed" : functionalNeedsReview ? "needs review" : "passed",
    polish: polishItem?.status === "passed" ? "completed" : polishItem || responsiveItem?.status === "failed" ? "recommended" : "pending",
    accessibility: criticalAccessibilityFailure ? "failed" : accessibilityNeedsReview ? "needs review" : "passed",
    pendingMessage: pending ? "The app was built successfully. It still needs review for accessibility, responsive layout, and polish before marking complete." : null,
  };
}

function qaStatusColor(status: string): string {
  if (["passed", "completed"].includes(status)) return "#34D399";
  if (status === "failed") return "#F87171";
  return "#FBBF24";
}

function fuguGateLabel(project?: Project | null): string {
  if (!project) return "pending";
  if (project.fuguGateOverrideReason) return "override recorded";
  if (project.fuguGateStatus === "pass") return "passed";
  if (project.fuguGateStatus === "revise") return "revision needed";
  if (project.fuguGateStatus === "unavailable") return "unavailable";
  if (project.fuguGateStatus === "error") return "error";
  return "pending";
}

function canBuildAfterFugu(project?: Project | null): boolean {
  return Boolean(project && (project.fuguGateStatus === "pass" || project.fuguGateOverrideReason));
}

function formatDate(iso?: string | null) {
  if (!iso) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function localPreviewPort(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).port || null;
  } catch {
    return url.match(/:(\d+)(?:\/|$)/)?.[1] ?? null;
  }
}

function localDevServerStatus(project: Project): string {
  if (project.previewStatus === "stale" || project.status === "Preview Stale") return "Preview Stale";
  if (project.previewStatus === "online" || project.status === "Dev Server Running") return "Dev Server Running";
  if (project.status === "Dev Server Stopped") return "Dev Server Stopped";
  return "Not Started";
}

function manualDevCommand(folder?: string | null): string | null {
  if (!folder) return null;
  return `cd "${folder}"\nnpm run dev`;
}

function LocalPreviewPanel({ project }: { project: Project }) {
  const [showLocalhostNote, setShowLocalhostNote] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const port = localPreviewPort(project.localDevUrl);
  const devStatus = localDevServerStatus(project);
  const command = manualDevCommand(project.localFolderPath);
  const qa = summarizeQa(project);

  useEffect(() => {
    setShowLocalhostNote(window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1");
  }, []);

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <div style={{ color: "#34D399", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase" }}>Local preview</div>
        <span style={badge(devStatus)}>{devStatus}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}>
        <span>Project: <strong style={{ color: "#F1F4FB" }}>{project.projectName}</strong></span>
        <span>Build status: <strong style={{ color: qaStatusColor(qa.build) }}>{qa.build}</strong></span>
        <span>Functional QA: <strong style={{ color: qaStatusColor(qa.functional) }}>{qa.functional}</strong></span>
        <span>Polish QA: <strong style={{ color: qaStatusColor(qa.polish) }}>{qa.polish}</strong></span>
        <span>Accessibility QA: <strong style={{ color: qaStatusColor(qa.accessibility) }}>{qa.accessibility}</strong></span>
        {qa.pendingMessage && <span style={{ color: "#FBBF24", lineHeight: 1.5 }}>{qa.pendingMessage}</span>}
        {project.localFolderPath && <span style={{ overflowWrap: "anywhere" }}>Folder: <code>{project.localFolderPath}</code></span>}
        {port && <span>Local port: <code>{port}</code></span>}
        {project.localDevUrl ? (
          <>
            <span>Local Preview: <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ color: project.previewStatus === "stale" ? "#FBBF24" : "#34D399" }}>{project.localDevUrl}</a></span>
            <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ ...previewAction, textDecoration: "none" }}>Open Preview</a>
              <button type="button" onClick={() => void navigator.clipboard.writeText(project.localDevUrl ?? "").then(() => setCopiedUrl(true))} style={previewAction}>{copiedUrl ? "URL Copied" : "Copy URL"}</button>
            </span>
          </>
        ) : (
          <span style={{ color: "#647089" }}>Local Preview: start the dev server to create a localhost URL.</span>
        )}
        {command && (
          <span>
            Manual command:
            <pre style={{ margin: "6px 0 0", padding: 9, borderRadius: 8, background: "rgba(8,13,24,0.48)", color: "#D8DEEB", font: "11px/1.45 JetBrains Mono,monospace", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{command}</pre>
          </span>
        )}
        {showLocalhostNote && (
          <span style={{ color: "#FBBF24" }}>Localhost preview links only open on the computer running the local worker. To access from phone, enable a tunnel later.</span>
        )}
      </div>
    </div>
  );
}

const previewAction: React.CSSProperties = {
  color: "#D8DEEB", background: "rgba(40,50,74,.46)", border: "1px solid #28324A",
  borderRadius: 8, padding: "7px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer",
};

export default function BuilderOffice() {
  const [prompt, setPrompt] = useState("");
  const [buildExecutor, setBuildExecutor] = useState<"local_worker" | "hermes_agent">("local_worker");
  const [executing, setExecuting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rootInfo, setRootInfo] = useState<RootInfo | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [health, setHealth] = useState<BuilderHealth | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [projectResponse, buildResponse, logResponse, localBuildResponse, healthResponse] = await Promise.all([
      fetch("/api/command-center/projects"),
      fetch("/api/command-center/builds"),
      fetch("/api/command-center/logs"),
      fetch("/api/command-center/local-builds"),
      fetch("/api/command-center/health-center"),
    ]);
    const projectData = await projectResponse.json() as { projects?: Project[] };
    const buildData = await buildResponse.json() as { builds?: Build[] };
    const logData = await logResponse.json() as { runs?: Run[] };
    const localBuildData = await localBuildResponse.json() as { root?: RootInfo; codex?: CodexStatus };
    const healthData = await healthResponse.json() as BuilderHealth | { error?: string };
    setProjects(projectData.projects ?? []);
    setBuilds(buildData.builds ?? []);
    setRuns(logData.runs ?? []);
    setRootInfo(localBuildData.root ?? null);
    setCodexStatus(localBuildData.codex ?? null);
    if ("apiProviders" in healthData && "executors" in healthData) setHealth(healthData);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const execute = async () => {
    const message = prompt.trim();
    if (!message || executing || generating || reviewing || managing) return;
    setExecuting(true);
    setResult(null);
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok) throw new Error(payload && "error" in payload && payload.error ? payload.error : `Local builder returned ${response.status}`);
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setExecuting(false);
    }
  };

  const generate = async () => {
    const message = prompt.trim();
    const targetProject = result?.project;
    if (!message || !targetProject || executing || generating || reviewing || managing) return;
    setGenerating(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", message, projectId: targetProject.id, executor: buildExecutor }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok && !(payload && "status" in payload && payload.status === "failed")) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : `Local builder returned ${response.status}`);
      }
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setGenerating(false);
    }
  };

  const manageProject = async (action: "open" | "startDev" | "stopDev" | "rebuild" | "runQa" | "runCodex") => {
    const targetProject = result?.project ?? projects[0];
    if (!targetProject || executing || generating || reviewing || managing) return;
    setManaging(action);
    setRequestError(null);
    if (action === "open" && targetProject.localFolderPath) {
      await navigator.clipboard?.writeText(targetProject.localFolderPath).then(() => setCopiedPath(targetProject.localFolderPath ?? null)).catch(() => undefined);
    }
    try {
      const defaultCodexPrompt = `Improve ${targetProject.projectName} so it feels like a real product, not a basic landing page. Add working cards, filters, saved/compare interactions, detail state, and responsive polish.`;
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, projectId: targetProject.id, message: prompt.trim() || (action === "runCodex" ? defaultCodexPrompt : targetProject.projectName) }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok && !(payload && "status" in payload && payload.status === "failed")) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : `Local builder returned ${response.status}`);
      }
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setManaging(null);
    }
  };

  const runFuguDesignReview = async () => {
    const targetProject = result?.project ?? projects[0];
    if (!targetProject || executing || generating || reviewing || managing) return;
    setReviewing(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fuguDesignReview", projectId: targetProject.id, message: prompt.trim() || targetProject.projectName }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : `Fugu design review returned ${response.status}`);
      }
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setReviewing(false);
    }
  };

  const runFuguGate = async () => {
    const targetProject = result?.project ?? projects[0];
    if (!targetProject || executing || generating || reviewing || managing) return;
    setReviewing(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fuguGate", projectId: targetProject.id, message: prompt.trim() || targetProject.projectName }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok) throw new Error(payload && "error" in payload && payload.error ? payload.error : `Fugu gate returned ${response.status}`);
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setReviewing(false);
    }
  };

  const overrideFuguGate = async () => {
    const targetProject = result?.project ?? projects[0];
    if (!targetProject || executing || generating || reviewing || managing) return;
    if (!window.confirm("Build without a passing Fugu gate? This records an override reason and keeps Fugu read-only.")) return;
    const reason = window.prompt("Why is it acceptable to continue without Fugu passing this design gate?");
    if (!reason?.trim()) return;
    setManaging("fuguGateOverride");
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fuguGateOverride", projectId: targetProject.id, message: reason }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok) throw new Error(payload && "error" in payload && payload.error ? payload.error : `Fugu override returned ${response.status}`);
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setManaging(null);
    }
  };

  const project = result?.project ?? projects[0];
  const qaSummary = project ? summarizeQa(project) : null;
  const build = builds[0];
  const files = result?.artifacts.filter((artifact) => artifact.type === "file") ?? [];
  const rawFirstError = requestError
    ?? (qaSummary?.build === "failed" ? result?.toolCalls.find((call) => call.error)?.error ?? (result?.status === "failed" ? result.answer : project?.buildError ?? null) : null);
  const firstError = rawFirstError ? redactBuildText(diagnoseBuildFailure([rawFirstError, project?.buildError]).exactError) : null;
  const busy = executing || generating || reviewing || Boolean(managing);
  const fuguBuildAllowed = canBuildAfterFugu(project);
  const displayStatus = managing ? "working" : reviewing ? "Reviewing" : generating ? "Generating" : executing ? "preparing" : result?.project?.status ?? result?.status ?? (firstError ? "failed" : "ready");
  const latestLog = runs.find((run) => run.agentName === "hermes-local-builder") ?? runs.find((run) => run.agentName === "hermes-execution");
  const fuguProvider = health?.apiProviders.find((provider) => provider.provider === "Sakana / Fugu");
  const localWorker = health?.executors.find((executor) => executor.name === "Local Worker");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.25fr) minmax(300px,.75fr)", gap: 20 }}>
      <section style={{ ...card, minHeight: 520, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 22 }}>
          <div>
            <div style={{ color: "#38BDF8", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Agents / Builder</div>
            <h2 style={{ color: "#F1F4FB", font: "700 24px Fraunces,serif", margin: "5px 0 4px" }}>Builder Office</h2>
            <p style={{ color: "#94A3B8", fontSize: 13, margin: 0 }}>Athena researches, Builder generates, QA validates, and Fugu can critique when the app feels too basic.</p>
          </div>
          <span style={badge(displayStatus)}>{displayStatus.replace(/_/g, " ")}</span>
        </div>

        <textarea
          aria-label="Builder prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void execute(); }}
          placeholder={"Build a website called MyProject with heading \"MyProject is live\" and one button \"Start.\""}
          rows={6}
          style={{ boxSizing: "border-box", width: "100%", color: "#F1F4FB", background: "rgba(14,20,36,.72)", border: "1px solid #28324A", borderRadius: 12, outline: "none", resize: "vertical", padding: "14px 16px", font: "13px/1.6 JetBrains Mono,monospace" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#94A3B8", fontSize: 11 }}>
            <span>Build with:</span>
            <select aria-label="Build executor" value={buildExecutor} onChange={(event) => setBuildExecutor(event.target.value as "local_worker" | "hermes_agent")} disabled={busy} style={{ color: "#D8DEEB", background: "#121A2B", border: "1px solid #28324A", borderRadius: 7, padding: "6px 8px", fontSize: 11 }}>
              <option value="local_worker">Local Builder</option>
              <option value="hermes_agent">Hermes Agent</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => void execute()} disabled={!prompt.trim() || busy} style={{ color: "#38BDF8", background: "rgba(56,189,248,.12)", border: "1px solid rgba(56,189,248,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !prompt.trim() || busy ? "not-allowed" : "pointer", opacity: !prompt.trim() || busy ? .5 : 1 }}>
            {executing ? "Preparing..." : "Prepare local build"}
          </button>
          <button onClick={() => void runFuguGate()} disabled={!project || busy} style={{ color: "#E879F9", background: "rgba(232,121,249,.12)", border: "1px solid rgba(232,121,249,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !project || busy ? "not-allowed" : "pointer", opacity: !project || busy ? .5 : 1 }}>
            {reviewing ? "Reviewing..." : "Run Fugu Gate"}
          </button>
          <button onClick={() => void generate()} disabled={!prompt.trim() || !result?.project || busy || !fuguBuildAllowed} style={{ color: "#34D399", background: "rgba(52,211,153,.12)", border: "1px solid rgba(52,211,153,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !prompt.trim() || !result?.project || busy || !fuguBuildAllowed ? "not-allowed" : "pointer", opacity: !prompt.trim() || !result?.project || busy || !fuguBuildAllowed ? .5 : 1 }}>
            {generating ? "Generating..." : `Generate with ${buildExecutor === "hermes_agent" ? "Hermes Agent" : "Local Builder"}`}
          </button>
          <button onClick={() => void runFuguDesignReview()} disabled={!project || busy} style={{ color: "#E879F9", background: "rgba(232,121,249,.12)", border: "1px solid rgba(232,121,249,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !project || busy ? "not-allowed" : "pointer", opacity: !project || busy ? .5 : 1 }}>
            {reviewing ? "Reviewing..." : "Run Fugu Design Review"}
          </button>
          </div>
        </div>

        <div style={{ marginTop: 22, flex: 1 }}>
          {!result && !firstError && !executing && <div style={{ color: "#4B5563", border: "1px dashed #28324A", borderRadius: 12, padding: 28, textAlign: "center", fontSize: 13 }}>Local builder output will appear here.</div>}
          {executing && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Hermes is routing the build to Athena, preparing the research brief, and creating the local project state.</div>}
          {generating && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Parawi is routing this build to {buildExecutor === "hermes_agent" ? "Hermes Agent" : "Local Builder"}.</div>}
          {reviewing && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Fugu is reviewing the current project as read-only design guidance.</div>}
          {managing && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Running local action: {managing}</div>}
          {result?.answer && !executing && <pre style={{ color: "#D8DEEB", background: "rgba(40,50,74,.36)", borderRadius: 10, margin: 0, padding: 14, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.6 JetBrains Mono,monospace" }}>{result.answer}</pre>}
          {firstError && !executing && <div style={{ color: "#F87171", background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.3)", borderRadius: 10, padding: 14, marginTop: 12, whiteSpace: "pre-wrap", fontSize: 12 }}><strong>First real error</strong><br />{firstError}</div>}
        </div>
      </section>

      <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Local builder root</div>
          {rootInfo ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}>
              <span style={{ overflowWrap: "anywhere" }}><code>{rootInfo.root}</code></span>
              <span>Folder: <strong style={{ color: rootInfo.exists ? "#34D399" : "#F87171" }}>{rootInfo.exists ? "found" : "missing"}</strong></span>
              <span>Local Worker: <strong style={{ color: localWorker?.status === "Online" ? "#34D399" : localWorker?.status === "Offline" ? "#F87171" : "#FBBF24" }}>{localWorker?.status?.toLowerCase() ?? "unknown"}</strong></span>
              <span>Projects found: {rootInfo.projectCount}</span>
              {rootInfo.warning && <span style={{ color: "#F87171" }}>{rootInfo.warning}</span>}
              {localWorker?.lastError && <span style={{ color: "#FBBF24" }}>{localWorker.lastError}</span>}
            </div>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>Root status not loaded yet.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Project and task</div>
          {project ? <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}><strong style={{ color: "#F1F4FB" }}>{project.projectName}</strong>{project.localFolderPath && <span style={{ overflowWrap: "anywhere" }}>Folder: <code>{project.localFolderPath}</code></span>}{copiedPath && <span style={{ color: "#34D399" }}>Folder path copied.</span>}{project.route && <span>{project.route}</span>}{formatDate(project.createdAt) && <span>Created: {formatDate(project.createdAt)}</span>}{project.currentTask && <span>Current task: {project.currentTask}</span>}<span>{project.taskCounts.done}/{project.taskCounts.total} tasks done</span><div><span style={badge(qaSummary?.build === "passed" && project.status === "qa_failed" ? "qa_pending" : project.status)}>{qaSummary?.build === "passed" && project.status === "qa_failed" ? "build passed / QA pending" : project.status.replace(/_/g, " ")}</span></div></div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No project state yet.</div>}
          {projects.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12, paddingTop: 10, borderTop: "1px solid #28324A" }}>{projects.slice(0, 6).map((item) => <a key={item.id} href={`/command-center?liveBuild=${encodeURIComponent(item.id)}#live-build-console`} style={{ display: "flex", justifyContent: "space-between", gap: 8, color: "#60A5FA", fontSize: 11, textDecoration: "none" }}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.projectName}</span><strong>View Live Build</strong></a>)}</div>}
        </div>
        {project && <ProjectInspector projectId={project.id} />}
        {project && <LocalPreviewPanel project={project} />}
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <div style={{ color: "#E879F9", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase" }}>Fugu design gate</div>
            <span style={badge(fuguGateLabel(project))}>{fuguGateLabel(project)}</span>
          </div>
          {project ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, color: "#94A3B8", fontSize: 12 }}>
              <span>Threshold: <strong style={{ color: "#D8DEEB" }}>{project.fuguGateReview?.threshold ?? 7}/10</strong></span>
              {typeof project.fuguGateScore === "number" && <span>Score: <strong style={{ color: project.fuguGateStatus === "pass" ? "#34D399" : "#FBBF24" }}>{project.fuguGateScore}/10</strong></span>}
              {project.fuguGateReview?.summary && <span style={{ color: "#D8DEEB", lineHeight: 1.5 }}>{project.fuguGateReview.summary}</span>}
              {project.fuguGateReview?.mustFixBeforeBuild?.length ? (
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                  {project.fuguGateReview.mustFixBeforeBuild.slice(0, 4).map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
              {project.fuguGateOverrideReason && <span style={{ color: "#FBBF24" }}>Override: {project.fuguGateOverrideReason}</span>}
              {project.fuguGateReviewedAt && <span>Reviewed: {formatDate(project.fuguGateReviewedAt)}</span>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => void runFuguGate()} disabled={busy} style={{ ...previewAction, color: "#E879F9", border: "1px solid rgba(232,121,249,.35)" }}>{reviewing ? "Reviewing..." : "Run Gate"}</button>
                {project.fuguGateStatus !== "pass" && <button onClick={() => void overrideFuguGate()} disabled={busy} style={{ ...previewAction, color: "#FBBF24", border: "1px solid rgba(251,191,36,.35)" }}>Continue Without Fugu</button>}
              </div>
            </div>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>Prepare a local build to create the pre-build gate.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#E879F9", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Athena / Fugu Brief Panel</div>
          {project?.researchBrief ? (
            <pre style={{ color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.55 JetBrains Mono,monospace", maxHeight: 260, overflow: "auto", margin: 0 }}>{project.researchBrief}</pre>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>No research brief yet.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#38BDF8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Codex CLI executor</div>
          {codexStatus ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}>
              <span>Installed: <strong style={{ color: codexStatus.installed ? "#34D399" : "#F87171" }}>{codexStatus.installed ? "yes" : "missing"}</strong></span>
              <span>Available: <strong style={{ color: codexStatus.available ? "#34D399" : "#F87171" }}>{codexStatus.available ? "yes" : "no"}</strong></span>
              <span>Version: <strong style={{ color: "#D8DEEB" }}>{codexStatus.version ?? "unknown"}</strong></span>
              <span>{codexStatus.message}</span>
            </div>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>Codex status not loaded yet.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <div style={{ color: "#38BDF8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase" }}>Fugu design review</div>
            {typeof project?.designScore === "number" && <span style={badge(`${project.designScore}/10`)}>{project.designScore}/10</span>}
          </div>
          {project?.designReview ? (
            <pre style={{ color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.55 JetBrains Mono,monospace", maxHeight: 260, overflow: "auto", margin: 0 }}>{project.designReview}</pre>
          ) : (
            <div style={{ color: fuguProvider?.configured ? "#60A5FA" : "#4B5563", fontSize: 12 }}>
              {fuguProvider?.configured ? `Fugu connected (${fuguProvider.status.replace(/_/g, " ")}). No design review saved yet.` : (fuguProvider?.safeError ?? "Fugu not connected - add SAKANA_API_KEY to environment.")}
            </div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#34D399", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Fugu polish review</div>
          {project?.polishReview ? (
            <pre style={{ color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.55 JetBrains Mono,monospace", maxHeight: 220, overflow: "auto", margin: 0 }}>{project.polishReview}</pre>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>Polish review appears after build.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <div style={{ color: "#FBBF24", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase" }}>Local QA checklist</div>
            {qaSummary && <span style={badge(qaSummary.pendingMessage ? "qa_pending" : project?.qaStatus ?? "ready")}>{qaSummary.pendingMessage ? "review pending" : project?.qaStatus?.replace(/_/g, " ")}</span>}
          </div>
          {qaSummary && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
              {[["Build status", qaSummary.build], ["Functional QA", qaSummary.functional], ["Polish QA", qaSummary.polish], ["Accessibility QA", qaSummary.accessibility]].map(([label, value]) => (
                <div key={label} style={{ padding: "9px 10px", border: "1px solid #28324A", borderRadius: 8, background: "rgba(8,13,24,.38)", fontSize: 11 }}>
                  <div style={{ color: "#647089", marginBottom: 3 }}>{label}</div>
                  <strong style={{ color: qaStatusColor(value) }}>{value}</strong>
                </div>
              ))}
            </div>
          )}
          {qaSummary?.pendingMessage && <div style={{ color: "#D8DEEB", background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.25)", borderRadius: 8, padding: 10, marginBottom: 12, fontSize: 12, lineHeight: 1.5 }}>{qaSummary.pendingMessage}</div>}
          {project?.qaChecklist?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {project.qaChecklist.map((item) => (
                <div key={item.key} style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 8, color: "#94A3B8", fontSize: 12 }}>
                  <span style={{ color: qaColor(item.status), fontWeight: 800 }}>{item.status === "passed" ? "✓" : item.status === "failed" ? "!" : "-"}</span>
                  <span><strong style={{ color: "#D8DEEB" }}>{item.label}</strong><br />{item.detail}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>QA checklist appears after Run QA Checklist.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Manage app</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[
              ["open", "Open Folder"],
              ["startDev", "Start Dev Server"],
              ["stopDev", "Stop Dev Server"],
              ["rebuild", "Rebuild"],
              ["runQa", "Run QA Checklist"],
              ["runCodex", "Run with Codex"],
            ].map(([action, label]) => (
              <button key={action} onClick={() => void manageProject(action as "open" | "startDev" | "stopDev" | "rebuild" | "runQa" | "runCodex")} disabled={!project || busy || (["rebuild", "runCodex"].includes(action) && !fuguBuildAllowed) || (action === "runCodex" && codexStatus?.available === false)} style={{ color: action === "runQa" ? "#FBBF24" : action === "runCodex" ? "#38BDF8" : "#D8DEEB", background: action === "runQa" ? "rgba(251,191,36,.12)" : action === "runCodex" ? "rgba(56,189,248,.12)" : "rgba(40,50,74,.46)", border: action === "runQa" ? "1px solid rgba(251,191,36,.35)" : action === "runCodex" ? "1px solid rgba(56,189,248,.35)" : "1px solid #28324A", borderRadius: 8, padding: "9px 10px", fontSize: 12, fontWeight: 700, cursor: !project || busy || (["rebuild", "runCodex"].includes(action) && !fuguBuildAllowed) || (action === "runCodex" && codexStatus?.available === false) ? "not-allowed" : "pointer", opacity: !project || busy || (["rebuild", "runCodex"].includes(action) && !fuguBuildAllowed) || (action === "runCodex" && codexStatus?.available === false) ? .5 : 1 }}>
                {managing === action ? "Working..." : label}
              </button>
            ))}
          </div>
          {project?.localDevUrl ? <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ display: "block", color: project.previewStatus === "stale" ? "#FBBF24" : "#34D399", marginTop: 12, fontSize: 12 }}>Open Preview: {project.localDevUrl}</a> : <div style={{ color: "#4B5563", marginTop: 12, fontSize: 12 }}>No local preview URL yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Files changed</div>
          {files.length ? files.map((file) => <div key={file.title} style={{ color: "#38BDF8", overflowWrap: "anywhere", font: "11px/1.5 JetBrains Mono,monospace" }}>{file.title}</div>) : <div style={{ color: "#4B5563", fontSize: 12 }}>No app files generated yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Build result</div>
          {project?.buildError && qaSummary?.build === "failed" && <div style={{ color: "#F87171", whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 10 }}>{project.buildError}</div>}
          {project?.buildLog ? <pre style={{ color: "#94A3B8", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.5 JetBrains Mono,monospace", maxHeight: 220, overflow: "auto", margin: 0 }}>{project.buildLog}</pre> : <div style={{ color: "#4B5563", fontSize: 12 }}>No build log yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Recent build record</div>
          {build ? <div style={{ display: "flex", flexDirection: "column", gap: 9, color: "#94A3B8", fontSize: 12 }}><strong style={{ color: "#F1F4FB" }}>{build.title}</strong><div><span style={badge(build.status)}>{build.status.replace(/_/g, " ")}</span></div>{build.branchName && <span>Branch: <code>{build.branchName}</code></span>}{build.commitSha && <span>Commit: <code>{build.commitSha.slice(0, 10)}</code></span>}{build.deploymentUrl ? <a href={build.deploymentUrl} target="_blank" rel="noopener" style={{ color: "#34D399" }}>{build.deploymentUrl}</a> : <span style={{ color: "#4B5563" }}>No deployment for local builds.</span>}{build.resultSummary && <span style={{ whiteSpace: "pre-wrap" }}>{build.resultSummary}</span>}</div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No code-generation build record yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Latest builder log</div>
          <div style={{ color: latestLog ? "#94A3B8" : "#4B5563", whiteSpace: "pre-wrap", fontSize: 12 }}>{latestLog?.outputSummary ?? "No builder log yet."}</div>
        </div>
      </aside>
    </div>
  );
}
