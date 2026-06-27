"use client";

import { useCallback, useEffect, useState } from "react";
import type { LiveBuildConsoleData } from "@/lib/live-build-console";

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export default function ProjectInspector({ projectId }: { projectId: string }) {
  const [data, setData] = useState<LiveBuildConsoleData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/command-center/live-build?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
    if (response.ok) setData(await response.json() as LiveBuildConsoleData);
  }, [projectId]);
  useEffect(() => { void refresh(); const interval = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(interval); }, [refresh]);

  const retry = async () => {
    setBusy("retry"); setMessage(null);
    const response = await fetch("/api/command-center/live-build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry", projectId }) });
    const result = await response.json().catch(() => null) as { error?: string } | null;
    setMessage(response.ok ? "Retry queued for the recorded failed task." : result?.error ?? "Retry could not be queued.");
    setBusy(null); await refresh();
  };
  const openFolder = async () => {
    setBusy("folder"); setMessage(null);
    const response = await fetch("/api/command-center/local-builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", projectId }) });
    setMessage(response.ok ? "Open-folder request sent to the Local Worker." : "Open-folder request failed. View technical logs.");
    setBusy(null);
  };

  if (!data?.project || !data.inspector) return <div style={panel}><Header /><div style={{ color: "#647089", fontSize: 11 }}>Inspector is loading recorded project state.</div></div>;
  const inspector = data.inspector;
  const failed = Boolean(inspector.exactError);
  const viewLogs = `/command-center?liveBuild=${encodeURIComponent(projectId)}#live-build-console`;

  return (
    <div style={panel}>
      <Header />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 7 }}>
        <Datum label="Current stage" value={inspector.currentStage} />
        <Datum label="Current step" value={inspector.currentStep} />
        <Datum label="Last successful step" value={inspector.lastSuccessfulStep ?? "None recorded"} />
        <Datum label="Last failed step" value={inspector.lastFailedStep ?? "None"} danger={Boolean(inspector.lastFailedStep)} />
        <Datum label="Worker" value={data.worker.status} danger={data.worker.status === "offline"} />
        <Datum label="Executor" value={data.project.executor} />
        <Datum label="Elapsed time" value={data.project.startedAt ? duration(Date.now() - new Date(data.project.startedAt).getTime()) : "Not started"} />
        <Datum label="Failure source" value={inspector.failureCategory ?? "None"} danger={failed} />
      </div>
      {failed && <div style={{ marginTop: 9, padding: "9px 10px", borderRadius: 7, border: "1px solid rgba(248,113,113,.28)", background: "rgba(248,113,113,.07)" }}><div style={{ color: "#F87171", fontSize: 9, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>Exact error</div><div style={{ color: "#FCA5A5", fontSize: 11, lineHeight: 1.45, overflowWrap: "anywhere" }}>{inspector.exactError}</div></div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        <button onClick={() => void retry()} disabled={!inspector.canRetry || busy !== null} style={{ ...button, opacity: inspector.canRetry ? 1 : .45 }}>{busy === "retry" ? "Queuing…" : "Retry"}</button>
        <a href={viewLogs} style={button}>View logs</a>
        <button onClick={() => void openFolder()} disabled={busy !== null} style={button}>{busy === "folder" ? "Opening…" : "Open folder"}</button>
        {data.preview?.url ? <a href={data.preview.url} target="_blank" rel="noopener" style={button}>Open preview</a> : <span style={{ ...button, opacity: .45 }}>Open preview</span>}
      </div>
      {message && <div style={{ color: message.includes("failed") || message.includes("could not") ? "#FBBF24" : "#94A3B8", fontSize: 10, marginTop: 8 }}>{message}</div>}
    </div>
  );
}

function Header() { return <div style={{ color: "#F1F4FB", fontSize: 13, fontWeight: 850, fontFamily: "Fraunces,serif", marginBottom: 10 }}>Project Inspector</div>; }
function Datum({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) { return <div style={{ padding: "7px 8px", borderRadius: 7, background: "rgba(8,13,24,.4)", border: "1px solid #28324A", minWidth: 0 }}><div style={{ color: "#647089", fontSize: 8, textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</div><div style={{ color: danger ? "#FCA5A5" : "#D8DEEB", fontSize: 10, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>{value.replace(/_/g, " ")}</div></div>; }
const panel: React.CSSProperties = { background: "linear-gradient(180deg,rgba(15,23,38,.92),rgba(8,13,24,.85))", border: "1px solid rgba(96,165,250,.24)", borderRadius: 12, padding: 12 };
const button: React.CSSProperties = { color: "#93C5FD", background: "rgba(96,165,250,.1)", border: "1px solid rgba(96,165,250,.28)", borderRadius: 7, padding: "7px 9px", fontSize: 10, fontWeight: 800, cursor: "pointer", textDecoration: "none" };
