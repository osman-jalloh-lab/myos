"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanonicalBuilderStage } from "@/lib/builder-lifecycle";
import { canonicalBuilderStageLabel } from "@/lib/builder-stage-display";
import { commandLogs, EXECUTION_CONSOLE_VIEWS, executionEngineLabel, testLogs, type ExecutionConsoleTab } from "@/lib/execution-console";
import { latestCanonicalBuilderStage, shouldPollLiveBuild, type LiveBuildConsoleData, type LiveBuildLog } from "@/lib/live-build-console";

type ProjectChoice = { id: string; projectName: string; canonicalStage: CanonicalBuilderStage; currentTask: string | null; updatedAt: string };
const tabs: Array<{ id: ExecutionConsoleTab; label: string }> = [
  { id: "console", label: "Console" }, { id: "changes", label: "Code Changes" }, { id: "commands", label: "Commands" },
  { id: "tests", label: "Tests" }, { id: "files", label: "Files" },
];

function tone(value: string): string {
  if (/complete|success|passed|online/i.test(value)) return "success";
  if (/fail|error|offline/i.test(value)) return "danger";
  if (/blocked|warning|stale|waiting|pending/i.test(value)) return "warning";
  return "info";
}
function clock(value: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—"; }
function elapsed(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1_000)); const minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }

export default function LiveBuildConsole({ projectId, compact = false }: { projectId?: string | null; compact?: boolean }) {
  const [data, setData] = useState<LiveBuildConsoleData | null>(null);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(projectId ?? (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("liveBuild") : null));
  const [tab, setTab] = useState<ExecutionConsoleTab>("console");
  const [topView, setTopView] = useState<"mission" | "code" | "trace">("mission");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const [source, setSource] = useState("all");
  const [runStatus, setRunStatus] = useState("all");
  const [paused, setPaused] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    if (paused) return;
    const queryString = selectedId ? `?projectId=${encodeURIComponent(selectedId)}` : "";
    const [liveResponse, projectResponse] = await Promise.all([
      fetch(`/api/command-center/live-build${queryString}`, { cache: "no-store" }),
      fetch("/api/command-center/projects", { cache: "no-store" }),
    ]);
    if (projectResponse.ok) {
      const payload = await projectResponse.json() as { projects?: ProjectChoice[] };
      const projectChoices = payload.projects ?? [];
      setProjects(projectChoices);
      if (!selectedId && projectChoices[0]) setSelectedId(projectChoices[0].id);
    }
    if (!liveResponse.ok) return;
    const incoming = await liveResponse.json() as LiveBuildConsoleData;
    setData((current) => {
      if (!current?.project || !incoming.project) return incoming;
      const canonicalStage = latestCanonicalBuilderStage(current.project.canonicalStage, incoming.project.canonicalStage);
      return { ...incoming, active: shouldPollLiveBuild(canonicalStage), project: { ...incoming.project, canonicalStage } };
    });
  }, [paused, selectedId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (paused || (data?.project && !shouldPollLiveBuild(data.project.canonicalStage))) return;
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, data?.project ? 4_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [data?.project, paused, refresh]);

  const sources = useMemo(() => [...new Set((data?.logs ?? []).map((item) => item.source))], [data?.logs]);
  const visibleLogs = useMemo(() => (data?.logs ?? []).filter((log) => {
    if (!technical && log.technical) return false;
    if (severity !== "all" && log.status !== severity) return false;
    if (source !== "all" && log.source !== source) return false;
    return !query || `${log.source} ${log.message}`.toLowerCase().includes(query.toLowerCase());
  }).slice(compact ? -6 : -120), [data?.logs, technical, severity, source, query, compact]);
  const commands = commandLogs(data?.logs ?? []);
  const tests = testLogs(data?.logs ?? []);
  const visibleProjects = useMemo(() => projects.filter((project) => {
    if (runStatus === "all") return true;
    if (runStatus === "active") return shouldPollLiveBuild(project.canonicalStage);
    if (runStatus === "completed") return /complete|success|passed/i.test(project.canonicalStage);
    return /fail|error|blocked/i.test(project.canonicalStage);
  }), [projects, runStatus]);
  const engine = data?.project ? executionEngineLabel(data.project.executor, data.logs) : "Not recorded";
  const participants = useMemo(() => {
    const evidence = `${data?.project?.executor ?? ""} ${(data?.logs ?? []).map((log) => `${log.source} ${log.message}`).join(" ")}`;
    return [
      { name: "Hermes", state: "ORCHESTRATING", show: /hermes|orchestrat|plan|approval/i.test(evidence) },
      { name: "Prometheus", state: data?.active ? "ACTIVE" : "RECORDED", show: Boolean(data?.project) },
      { name: "Codex CLI", state: /fail|error/i.test(evidence) ? "FAILED" : "CODING", show: /codex/i.test(evidence) },
      { name: "Claude", state: "REVIEWED", show: /claude|anthropic/i.test(evidence) },
      { name: "DeepSeek", state: "CHALLENGED", show: /deepseek/i.test(evidence) },
      { name: "Docker", state: data?.preview?.status ?? "RUNNING", show: /docker|container|preview/i.test(evidence) || Boolean(data?.preview) },
      { name: "Validation", state: tests.some((item) => /fail|error/i.test(`${item.status} ${item.message}`)) ? "FAILED" : tests.length ? "RECORDED" : "WAITING", show: Boolean(data?.project) },
    ].filter((participant) => participant.show);
  }, [data, tests]);

  const copyVisible = async () => { await navigator.clipboard.writeText(visibleLogs.map((item) => `${item.timestamp ?? ""} ${item.source} ${item.message}`).join("\n")); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); };
  if (compact) return <CompactConsole data={data} engine={engine} />;

  return <section className="execution-console" aria-labelledby="execution-console-title">
    <header className="execution-console-header">
      <div><span>Execution glass box</span><h1 id="execution-console-title">Live Console</h1><p>See what My OS actually did, who acted, which engine ran, and what evidence was recorded.</p></div>
      <div className="execution-chain" aria-label="Execution identity chain"><b>Prometheus<small>Agent</small></b><i>→</i><b>{engine}<small>Execution engine</small></b><i>→</i><b>{data?.project ? canonicalBuilderStageLabel(data.project.canonicalStage) : "Idle"}<small>Result state</small></b></div>
    </header>

    {!data?.project ? <div className="execution-console-empty"><h2>No selected execution</h2><p>Select a persisted Builder project when one becomes available. No run data is fabricated.</p></div> : <>
      <div className="execution-run-summary">
        <div><span>Project</span><strong>{data.project.name}</strong><small>{data.project.appType}</small></div>
        <div><span>Task</span><strong>{data.project.statusMeaning}</strong><small>{data.project.status}</small></div>
        <div><span>Agent</span><strong>Prometheus</strong><small>Engineering</small></div>
        <div><span>Engine</span><strong>{engine}</strong><small>{data.project.executor}</small></div>
        <div><span>Status</span><strong className={`status ${tone(data.project.canonicalStage)}`}>{canonicalBuilderStageLabel(data.project.canonicalStage)}</strong><small>{data.project.stuck ? "May be stuck" : "Recorded state"}</small></div>
        <div><span>Timing</span><strong>{elapsed(data.project.startedAt ? Math.max(0, now - new Date(data.project.startedAt).getTime()) : data.project.elapsedMs)}</strong><small>Started {clock(data.project.startedAt)}</small></div>
      </div>

      <div className="execution-top-tabs" role="tablist" aria-label="Live Console views">
        {EXECUTION_CONSOLE_VIEWS.map((view) => <button key={view} role="tab" aria-selected={topView === view} onClick={() => setTopView(view)}>{view.toUpperCase()}</button>)}
      </div>

      {topView === "mission" && <section className="execution-mission" aria-label="Mission view">
        <div className="execution-mission-brief"><span>Current mission</span><h2>{data.project.statusMeaning}</h2><p>{data.project.stuck ? data.inspector?.exactError ?? "This run may be blocked." : `Hermes is tracking ${data.project.name} through ${canonicalBuilderStageLabel(data.project.canonicalStage)}.`}</p><dl><div><dt>Workspace</dt><dd>{data.project.name}</dd></div><div><dt>Runtime</dt><dd>{engine}</dd></div><div><dt>Phase</dt><dd>{canonicalBuilderStageLabel(data.project.canonicalStage)}</dd></div><div><dt>Approval</dt><dd>{/approval/i.test(data.project.status) ? "Required" : "No current approval recorded"}</dd></div><div><dt>Result / blocker</dt><dd>{data.inspector?.exactError ?? data.inspector?.lastSuccessfulStep ?? "Work in progress"}</dd></div></dl></div>
        <div className="execution-workers"><header><span>Active workers</span><h2>Participants recorded in this run</h2></header>{participants.map((participant) => <div key={participant.name}><strong>{participant.name}</strong><span className={`status ${tone(participant.state)}`}>{participant.state}</span></div>)}</div>
      </section>}

      {topView === "code" && <div className="execution-console-layout">
        <aside className="execution-run-list" aria-label="Run and project list"><header><div><span>Sessions</span><h2>Builder runs</h2></div><select aria-label="Filter run status" value={runStatus} onChange={(event) => setRunStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="completed">Completed</option><option value="failed">Failed</option></select></header>{visibleProjects.map((project) => <button key={project.id} type="button" className={project.id === data.project?.id ? "active" : ""} onClick={() => setSelectedId(project.id)}><strong>{project.projectName}</strong><span className={`status ${tone(project.canonicalStage)}`}>{project.canonicalStage}</span><small>{project.currentTask ?? `Updated ${new Date(project.updatedAt).toLocaleDateString()}`}</small></button>)}{!visibleProjects.length && <p>{projects.length ? "No sessions match this filter." : "No persisted projects were returned."}</p>}</aside>

        <main className="execution-stream">
          <div className="execution-tabs" role="tablist" aria-label="Execution evidence sections">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
          {tab === "console" && <><div className="execution-log-controls"><label><span>Search logs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search action or output" /></label><label><span>Severity</span><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All levels</option><option value="info">Info</option><option value="success">Success</option><option value="warning">Warning</option><option value="error">Error</option></select></label><label><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((item) => <option key={item}>{item}</option>)}</select></label><button type="button" aria-pressed={technical} onClick={() => setTechnical((value) => !value)}>{technical ? "Hide technical" : "Show technical"}</button><button type="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>{paused ? "Resume stream" : "Pause stream"}</button><button type="button" onClick={() => void copyVisible()}>{copied ? "Copied" : "Copy visible"}</button></div><LogStream logs={visibleLogs}/></>}
          {tab === "changes" && <EvidenceView title="Code Changes" description="Files inferred from persisted Builder evidence. Diff content is shown only when it was recorded safely."><FileList files={data.files}/><EmptyEvidence when={!data.files.length}>No code-change metadata was recorded for this run.</EmptyEvidence></EvidenceView>}
          {tab === "commands" && <EvidenceView title="Commands" description="Recorded command and package-tool output, grouped away from the main stream."><LogCards logs={commands}/><EmptyEvidence when={!commands.length}>No command evidence was recorded.</EmptyEvidence></EvidenceView>}
          {tab === "tests" && <EvidenceView title="Tests & QA" description="Build, test, lint, typecheck, and browser-QA evidence from the persisted log."><LogCards logs={tests}/><EmptyEvidence when={!tests.length}>No test or QA evidence was recorded.</EmptyEvidence></EvidenceView>}
          {tab === "files" && <EvidenceView title="Touched Files" description="Safe project-relative paths only. Environment and credential files are excluded upstream."><FileList files={data.files}/><EmptyEvidence when={!data.files.length}>No safe file paths were recorded.</EmptyEvidence></EvidenceView>}
        </main>

        <aside className="execution-inspector" aria-label="Selected run inspector"><header><span>Run inspector</span><h2>Current evidence</h2></header><dl><div><dt>Current step</dt><dd>{data.inspector?.currentStep ?? "Unavailable"}</dd></div><div><dt>Agent</dt><dd>Prometheus</dd></div><div><dt>Engine</dt><dd>{engine}</dd></div><div><dt>Worker</dt><dd className={`status ${tone(data.worker.status)}`}>{data.worker.status}</dd></div><div><dt>Approval</dt><dd>{/approval/i.test(data.project.status) ? "Required" : "Not recorded"}</dd></div><div><dt>Last successful</dt><dd>{data.inspector?.lastSuccessfulStep ?? "Unavailable"}</dd></div><div><dt>Failure</dt><dd>{data.inspector?.exactError ?? "None recorded"}</dd></div></dl>{data.project.folderPath && <details><summary>Safe workspace path</summary><code>{data.project.folderPath}</code></details>}{data.preview && <div className="execution-artifact"><span>Result artifact</span><strong>Docker preview · {data.preview.status}</strong><a href={data.preview.url} target="_blank" rel="noreferrer">Open preview</a></div>}</aside>
      </div>}
      {topView === "trace" && <section className="execution-trace-view"><header><span>Decision trail</span><h2>Why this execution happened</h2><p>Only persisted Builder lifecycle and execution evidence is shown.</p></header><ol className="execution-trace">{data.timeline.map((step) => <li key={step.key} className={tone(step.status)}><span/><div><strong>{step.label}</strong><small>{step.status} · {clock(step.timestamp)}</small></div></li>)}</ol><div className="execution-trace-details"><div><span>Request / task</span><strong>{data.project.statusMeaning}</strong></div><div><span>Delegation</span><strong>Prometheus → {engine}</strong></div><div><span>Validation evidence</span><strong>{tests.length ? `${tests.length} recorded event${tests.length === 1 ? "" : "s"}` : "None recorded"}</strong></div><div><span>Final state</span><strong>{canonicalBuilderStageLabel(data.project.canonicalStage)}</strong></div></div></section>}
    </>}
  </section>;
}

function CompactConsole({ data, engine }: { data: LiveBuildConsoleData | null; engine: string }) { return <section className="execution-console compact" aria-label="Live Build Console"><strong>{data?.project?.name ?? "No active build"}</strong><span>{data?.project ? `${canonicalBuilderStageLabel(data.project.canonicalStage)} · ${engine}` : "Waiting for Builder telemetry"}</span></section>; }
function LogStream({ logs }: { logs: LiveBuildLog[] }) { return <div className="execution-log-stream">{logs.map((log, index) => <article key={`${log.timestamp}-${index}`}><time>{clock(log.timestamp)}</time><div><header><strong>{log.source}</strong><span className={`status ${tone(log.status)}`}>{log.status}</span></header><pre>{log.message}</pre></div></article>)}{!logs.length && <p>No matching persisted logs.</p>}</div>; }
function LogCards({ logs }: { logs: LiveBuildLog[] }) { return <div className="execution-evidence-list">{logs.map((log, index) => <details key={`${log.timestamp}-${index}`}><summary><span>{clock(log.timestamp)}</span><strong>{log.source}</strong><em className={`status ${tone(log.status)}`}>{log.status}</em></summary><pre>{log.message}</pre></details>)}</div>; }
function FileList({ files }: { files: string[] }) { return <div className="execution-file-list">{files.map((file) => <div key={file}><span>MOD</span><code>{file}</code></div>)}</div>; }
function EvidenceView({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="execution-evidence"><header><h2>{title}</h2><p>{description}</p></header>{children}</section>; }
function EmptyEvidence({ when, children }: { when: boolean; children: React.ReactNode }) { return when ? <p className="execution-empty-copy">{children}</p> : null; }
