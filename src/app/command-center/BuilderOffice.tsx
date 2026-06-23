"use client";

import { useCallback, useEffect, useState } from "react";

type Artifact = { type: string; title: string; url?: string; content?: string; metadata?: Record<string, unknown> };
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
  researchBrief?: string | null;
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

const card: React.CSSProperties = { background: "rgba(26,35,54,.85)", border: "1px solid #28324A", borderRadius: 16, padding: "20px 24px", backdropFilter: "blur(12px)" };

function badge(status: string): React.CSSProperties {
  const color = ["completed", "done", "deployed", "Ready to Build", "Brief Ready", "Build Passed", "Dev Server Running", "ready_to_build"].includes(status) ? "#34D399" : ["failed", "blocked", "Build Failed"].includes(status) ? "#F87171" : ["ready", "Dev Server Stopped"].includes(status) ? "#60A5FA" : "#A78BFA";
  return { display: "inline-block", color, background: `${color}18`, border: `1px solid ${color}45`, borderRadius: 999, padding: "3px 9px", fontSize: 11, fontWeight: 700 };
}

function formatDate(iso?: string | null) {
  if (!iso) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export default function BuilderOffice() {
  const [prompt, setPrompt] = useState("");
  const [executing, setExecuting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rootInfo, setRootInfo] = useState<RootInfo | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [projectResponse, buildResponse, logResponse, localBuildResponse] = await Promise.all([
      fetch("/api/command-center/projects"),
      fetch("/api/command-center/builds"),
      fetch("/api/command-center/logs"),
      fetch("/api/command-center/local-builds"),
    ]);
    const projectData = await projectResponse.json() as { projects?: Project[] };
    const buildData = await buildResponse.json() as { builds?: Build[] };
    const logData = await logResponse.json() as { runs?: Run[] };
    const localBuildData = await localBuildResponse.json() as { root?: RootInfo };
    setProjects(projectData.projects ?? []);
    setBuilds(buildData.builds ?? []);
    setRuns(logData.runs ?? []);
    setRootInfo(localBuildData.root ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const execute = async () => {
    const message = prompt.trim();
    if (!message || executing || generating || managing) return;
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
    if (!message || !targetProject || executing || generating || managing) return;
    setGenerating(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", message, projectId: targetProject.id }),
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

  const manageProject = async (action: "open" | "startDev" | "stopDev" | "rebuild") => {
    const targetProject = result?.project ?? projects[0];
    if (!targetProject || executing || generating || managing) return;
    setManaging(action);
    setRequestError(null);
    if (action === "open" && targetProject.localFolderPath) {
      await navigator.clipboard?.writeText(targetProject.localFolderPath).then(() => setCopiedPath(targetProject.localFolderPath ?? null)).catch(() => undefined);
    }
    try {
      const response = await fetch("/api/command-center/local-builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, projectId: targetProject.id, message: prompt.trim() || targetProject.projectName }),
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

  const project = result?.project ?? projects[0];
  const build = builds[0];
  const files = result?.artifacts.filter((artifact) => artifact.type === "file") ?? [];
  const firstError = requestError ?? result?.toolCalls.find((call) => call.error)?.error ?? (result?.status === "failed" ? result.answer : null);
  const busy = executing || generating || Boolean(managing);
  const displayStatus = managing ? "working" : generating ? "Generating" : executing ? "preparing" : result?.project?.status ?? result?.status ?? (firstError ? "failed" : "ready");
  const latestLog = runs.find((run) => run.agentName === "hermes-local-builder") ?? runs.find((run) => run.agentName === "hermes-execution");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.25fr) minmax(300px,.75fr)", gap: 20 }}>
      <section style={{ ...card, minHeight: 520, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 22 }}>
          <div>
            <div style={{ color: "#38BDF8", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Agents / Builder</div>
            <h2 style={{ color: "#F1F4FB", font: "700 24px Fraunces,serif", margin: "5px 0 4px" }}>Builder Office</h2>
            <p style={{ color: "#94A3B8", fontSize: 13, margin: 0 }}>Athena researches the request, then Local Builder prepares, generates, and validates the app.</p>
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
          <span style={{ color: "#4B5563", fontSize: 11 }}>Ctrl/Cmd + Enter to run</span>
          <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => void execute()} disabled={!prompt.trim() || busy} style={{ color: "#38BDF8", background: "rgba(56,189,248,.12)", border: "1px solid rgba(56,189,248,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !prompt.trim() || busy ? "not-allowed" : "pointer", opacity: !prompt.trim() || busy ? .5 : 1 }}>
            {executing ? "Preparing..." : "Prepare local build"}
          </button>
          <button onClick={() => void generate()} disabled={!prompt.trim() || !result?.project || busy} style={{ color: "#34D399", background: "rgba(52,211,153,.12)", border: "1px solid rgba(52,211,153,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !prompt.trim() || !result?.project || busy ? "not-allowed" : "pointer", opacity: !prompt.trim() || !result?.project || busy ? .5 : 1 }}>
            {generating ? "Generating..." : "Generate app"}
          </button>
          </div>
        </div>

        <div style={{ marginTop: 22, flex: 1 }}>
          {!result && !firstError && !executing && <div style={{ color: "#4B5563", border: "1px dashed #28324A", borderRadius: 12, padding: 28, textAlign: "center", fontSize: 13 }}>Local builder output will appear here.</div>}
          {executing && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Hermes is routing the build to Athena, preparing the research brief, and creating the local project state.</div>}
          {generating && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Hermes is generating the starter app, installing dependencies, and running the build.</div>}
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
              <span>Projects found: {rootInfo.projectCount}</span>
              {rootInfo.warning && <span style={{ color: "#F87171" }}>{rootInfo.warning}</span>}
            </div>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>Root status not loaded yet.</div>
          )}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Project and task</div>
          {project ? <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}><strong style={{ color: "#F1F4FB" }}>{project.projectName}</strong>{project.localFolderPath && <span style={{ overflowWrap: "anywhere" }}>Folder: <code>{project.localFolderPath}</code></span>}{copiedPath && <span style={{ color: "#34D399" }}>Folder path copied.</span>}{project.localDevUrl && <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ color: "#34D399" }}>{project.localDevUrl}</a>}{project.route && <span>{project.route}</span>}{formatDate(project.createdAt) && <span>Created: {formatDate(project.createdAt)}</span>}{project.currentTask && <span>Current task: {project.currentTask}</span>}<span>{project.taskCounts.done}/{project.taskCounts.total} tasks done</span><div><span style={badge(project.status)}>{project.status}</span></div></div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No project state yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#E879F9", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Athena Office</div>
          {project?.researchBrief ? (
            <pre style={{ color: "#D8DEEB", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "11px/1.55 JetBrains Mono,monospace", maxHeight: 260, overflow: "auto", margin: 0 }}>{project.researchBrief}</pre>
          ) : (
            <div style={{ color: "#4B5563", fontSize: 12 }}>No research brief yet.</div>
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
            ].map(([action, label]) => (
              <button key={action} onClick={() => void manageProject(action as "open" | "startDev" | "stopDev" | "rebuild")} disabled={!project || busy} style={{ color: "#D8DEEB", background: "rgba(40,50,74,.46)", border: "1px solid #28324A", borderRadius: 8, padding: "9px 10px", fontSize: 12, fontWeight: 700, cursor: !project || busy ? "not-allowed" : "pointer", opacity: !project || busy ? .5 : 1 }}>
                {managing === action ? "Working..." : label}
              </button>
            ))}
          </div>
          {project?.localDevUrl ? <a href={project.localDevUrl} target="_blank" rel="noopener" style={{ display: "block", color: "#34D399", marginTop: 12, fontSize: 12 }}>View Local URL</a> : <div style={{ color: "#4B5563", marginTop: 12, fontSize: 12 }}>No local preview URL yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Files changed</div>
          {files.length ? files.map((file) => <div key={file.title} style={{ color: "#38BDF8", overflowWrap: "anywhere", font: "11px/1.5 JetBrains Mono,monospace" }}>{file.title}</div>) : <div style={{ color: "#4B5563", fontSize: 12 }}>No app files generated yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Build result</div>
          {project?.buildError && <div style={{ color: "#F87171", whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 10 }}>{project.buildError}</div>}
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
