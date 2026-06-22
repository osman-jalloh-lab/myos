"use client";

import { useCallback, useState } from "react";

type Artifact = { type: string; title: string; url?: string; content?: string; metadata?: Record<string, unknown> };
type ExecutionResult = { status: string; answer: string; artifacts: Artifact[]; toolCalls: Array<{ tool: string; status: string; error?: string }> };
type Project = { id: string; projectName: string; route: string | null; status: string; taskCounts: { done: number; total: number } };
type Build = { id: string; title: string; status: string; resultSummary: string | null; implementationSummary: string | null; branchName: string | null; commitSha: string | null; deploymentUrl: string | null; sanitizedError: string | null };
type Run = { id: string; agentName: string; outputSummary: string | null; status: string };

const card: React.CSSProperties = { background: "rgba(26,35,54,.85)", border: "1px solid #28324A", borderRadius: 16, padding: "20px 24px", backdropFilter: "blur(12px)" };

function routeFromPrompt(prompt: string) {
  return prompt.match(/\/(?!api(?:\/|\b)|auth(?:\/|\b))([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)/i)?.[0] ?? null;
}

function badge(status: string): React.CSSProperties {
  const color = ["completed", "done", "deployed"].includes(status) ? "#34D399" : ["failed", "blocked"].includes(status) ? "#F87171" : status === "ready" ? "#60A5FA" : "#A78BFA";
  return { display: "inline-block", color, background: `${color}18`, border: `1px solid ${color}45`, borderRadius: 999, padding: "3px 9px", fontSize: 11, fontWeight: 700, textTransform: "capitalize" };
}

export default function BuilderOffice() {
  const [prompt, setPrompt] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [projectResponse, buildResponse, logResponse] = await Promise.all([
      fetch("/api/command-center/projects"),
      fetch("/api/command-center/builds"),
      fetch("/api/command-center/logs"),
    ]);
    const projectData = await projectResponse.json() as { projects?: Project[] };
    const buildData = await buildResponse.json() as { builds?: Build[] };
    const logData = await logResponse.json() as { runs?: Run[] };
    setProjects(projectData.projects ?? []);
    setBuilds(buildData.builds ?? []);
    setRuns(logData.runs ?? []);
  }, []);

  const execute = async () => {
    const message = prompt.trim();
    if (!message || executing) return;
    setExecuting(true);
    setResult(null);
    setRequestError(null);
    try {
      const response = await fetch("/api/hermes/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, source: "chat", sessionId: "builder-office" }),
      });
      const payload = await response.json().catch(() => null) as ExecutionResult | { error?: string } | null;
      if (!response.ok) throw new Error(payload && "error" in payload && payload.error ? payload.error : `Execution endpoint returned ${response.status}`);
      setResult(payload as ExecutionResult);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh().catch(() => undefined);
      setExecuting(false);
    }
  };

  const route = routeFromPrompt(prompt);
  const project = route ? projects.find((item) => item.route === route) : projects[0];
  const build = route ? builds.find((item) => item.title.toLowerCase().includes(route.toLowerCase())) : builds[0];
  const files = result?.artifacts.filter((artifact) => artifact.type === "file") ?? [];
  const firstError = requestError ?? build?.sanitizedError ?? result?.toolCalls.find((call) => call.error)?.error ?? (result?.status === "failed" ? result.answer : null);
  const displayStatus = executing ? "executing" : result?.status ?? (firstError ? "failed" : "ready");
  const latestLog = runs.find((run) => run.agentName === "hermes-execution");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.25fr) minmax(300px,.75fr)", gap: 20 }}>
      <section style={{ ...card, minHeight: 520, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 22 }}>
          <div>
            <div style={{ color: "#38BDF8", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Agents / Builder</div>
            <h2 style={{ color: "#F1F4FB", font: "700 24px Fraunces,serif", margin: "5px 0 4px" }}>Builder Office</h2>
            <p style={{ color: "#94A3B8", fontSize: 13, margin: 0 }}>Real Hermes execution. No timer-only queue or simulated build phases.</p>
          </div>
          <span style={badge(displayStatus)}>{displayStatus.replace(/_/g, " ")}</span>
        </div>

        <textarea
          aria-label="Builder prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void execute(); }}
          placeholder="Build a page at /test-office-exec with heading “Office execution works” and one button that says “Run Office Test.”"
          rows={6}
          style={{ boxSizing: "border-box", width: "100%", color: "#F1F4FB", background: "rgba(14,20,36,.72)", border: "1px solid #28324A", borderRadius: 12, outline: "none", resize: "vertical", padding: "14px 16px", font: "13px/1.6 JetBrains Mono,monospace" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <span style={{ color: "#4B5563", fontSize: 11 }}>Ctrl/⌘ + Enter to run</span>
          <button onClick={() => void execute()} disabled={!prompt.trim() || executing} style={{ color: "#38BDF8", background: "rgba(56,189,248,.12)", border: "1px solid rgba(56,189,248,.4)", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: !prompt.trim() || executing ? "not-allowed" : "pointer", opacity: !prompt.trim() || executing ? .5 : 1 }}>
            {executing ? "Running real build…" : "Execute build"}
          </button>
        </div>

        <div style={{ marginTop: 22, flex: 1 }}>
          {!result && !firstError && !executing && <div style={{ color: "#4B5563", border: "1px dashed #28324A", borderRadius: 12, padding: 28, textAlign: "center", fontSize: 13 }}>Execution output will appear here.</div>}
          {executing && <div style={{ color: "#A78BFA", border: "1px solid rgba(167,139,250,.3)", borderRadius: 12, padding: 18, fontSize: 13 }}>Hermes is executing the request and running repository validation.</div>}
          {result?.answer && !executing && <pre style={{ color: "#D8DEEB", background: "rgba(40,50,74,.36)", borderRadius: 10, margin: 0, padding: 14, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.6 JetBrains Mono,monospace" }}>{result.answer}</pre>}
          {firstError && !executing && <div style={{ color: "#F87171", background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.3)", borderRadius: 10, padding: 14, marginTop: 12, whiteSpace: "pre-wrap", fontSize: 12 }}><strong>First real error</strong><br />{firstError}</div>}
        </div>
      </section>

      <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Real build record</div>
          {build ? <div style={{ display: "flex", flexDirection: "column", gap: 9, color: "#94A3B8", fontSize: 12 }}><strong style={{ color: "#F1F4FB" }}>{build.title}</strong><div><span style={badge(build.status)}>{build.status.replace(/_/g, " ")}</span></div>{build.branchName && <span>Branch: <code>{build.branchName}</code></span>}{build.commitSha && <span>Commit: <code>{build.commitSha.slice(0, 10)}</code></span>}{build.deploymentUrl ? <a href={build.deploymentUrl} target="_blank" rel="noopener" style={{ color: "#34D399" }}>{build.deploymentUrl}</a> : <span style={{ color: "#4B5563" }}>Deployment URL not available for this execution.</span>}{build.resultSummary && <span style={{ whiteSpace: "pre-wrap" }}>{build.resultSummary}</span>}</div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No real build record yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Files changed</div>
          {files.length ? files.map((file) => <div key={file.title} style={{ color: "#38BDF8", overflowWrap: "anywhere", font: "11px/1.5 JetBrains Mono,monospace" }}>{file.title}</div>) : build?.implementationSummary ? <div style={{ color: "#94A3B8", whiteSpace: "pre-wrap", fontSize: 12 }}>{build.implementationSummary}</div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No reported file changes.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Project and task</div>
          {project ? <div style={{ display: "flex", flexDirection: "column", gap: 7, color: "#94A3B8", fontSize: 12 }}><strong style={{ color: "#F1F4FB" }}>{project.projectName}</strong><span>{project.route}</span><span>{project.taskCounts.done}/{project.taskCounts.total} tasks done</span><div><span style={badge(project.status)}>{project.status}</span></div></div> : <div style={{ color: "#4B5563", fontSize: 12 }}>No project state yet.</div>}
        </div>
        <div style={card}>
          <div style={{ color: "#94A3B8", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 12 }}>Latest executor log</div>
          <div style={{ color: latestLog ? "#94A3B8" : "#4B5563", whiteSpace: "pre-wrap", fontSize: 12 }}>{latestLog?.outputSummary ?? "No executor log yet."}</div>
        </div>
      </aside>
    </div>
  );
}
