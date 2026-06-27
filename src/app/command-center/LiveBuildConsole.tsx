"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuildStepStatus, LiveBuildConsoleData } from "@/lib/live-build-console";

const shell: React.CSSProperties = { background: "linear-gradient(180deg, rgba(19,28,44,.97), rgba(8,14,25,.95))", border: "1px solid rgba(96,165,250,.28)", borderRadius: 10, boxShadow: "0 16px 38px rgba(0,0,0,.24)", overflow: "hidden" };
const mono: React.CSSProperties = { fontFamily: "JetBrains Mono, ui-monospace, monospace" };

function tone(status: BuildStepStatus | string): string {
  if (["complete", "online"].includes(status)) return "#34D399";
  if (["failed", "offline", "error"].includes(status)) return "#F87171";
  if (["running", "info"].includes(status)) return "#60A5FA";
  if (["warning", "stale"].includes(status)) return "#FBBF24";
  return "#647089";
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function clock(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export default function LiveBuildConsole({ projectId, compact = false }: { projectId?: string | null; compact?: boolean }) {
  const [data, setData] = useState<LiveBuildConsoleData | null>(null);
  const [technical, setTechnical] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const selectedId = projectId ?? (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("liveBuild") : null);

  const refresh = useCallback(async () => {
    const query = selectedId ? `?projectId=${encodeURIComponent(selectedId)}` : "";
    const response = await fetch(`/api/command-center/live-build${query}`, { cache: "no-store" });
    if (response.ok) setData(await response.json() as LiveBuildConsoleData);
  }, [selectedId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const interval = window.setInterval(() => { setNow(Date.now()); void refresh(); }, data?.active ? 4_000 : 15_000);
    return () => window.clearInterval(interval);
  }, [data?.active, refresh]);

  const visibleLogs = useMemo(() => (data?.logs ?? []).filter((log) => technical || !log.technical).slice(compact ? -6 : -80), [data?.logs, technical, compact]);
  const copy = async (value: string, key: string) => { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(null), 1600); };
  const openFolder = async () => {
    if (!data?.project?.id || data.project.id === "intake") return;
    await fetch("/api/command-center/local-builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", projectId: data.project.id }) });
  };

  return (
    <section id="live-build-console" style={shell} aria-label="Live Build Console">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", padding: compact ? "10px 12px" : "13px 15px", borderBottom: "1px solid rgba(93,111,143,.22)", background: "rgba(15,23,38,.8)" }}>
        <div>
          <div style={{ color: "#F1F4FB", fontSize: compact ? 14 : 17, fontWeight: 850, fontFamily: "Fraunces, serif" }}>Live Build Console</div>
          <div style={{ color: "#647089", fontSize: 10, marginTop: 2, letterSpacing: ".08em", textTransform: "uppercase" }}>Builder · Worker · QA telemetry</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: tone(data?.worker.status ?? "offline"), boxShadow: `0 0 14px ${tone(data?.worker.status ?? "offline")}88` }} />
          <span style={{ color: "#94A3B8", fontSize: 10 }}>Worker {data?.worker.status ?? "checking"}</span>
          <button onClick={() => setTechnical((value) => !value)} style={{ border: "1px solid #28324A", background: technical ? "rgba(96,165,250,.16)" : "rgba(8,13,24,.5)", color: technical ? "#93C5FD" : "#94A3B8", borderRadius: 7, padding: "6px 8px", fontSize: 10, cursor: "pointer" }}>{technical ? "Hide technical logs" : "Show technical logs"}</button>
        </div>
      </div>

      {!data?.project ? (
        <div style={{ padding: compact ? 18 : 30, textAlign: "center", color: "#94A3B8", fontSize: 12 }}>No active build. Start a project from Builder Office.</div>
      ) : (
        <div style={{ padding: compact ? 12 : 15, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: compact ? "minmax(0,1fr) auto" : "minmax(220px,1.5fr) repeat(4,minmax(100px,auto))", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#F1F4FB", fontSize: 15, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.project.name}</div>
              <div style={{ color: "#60A5FA", fontSize: 10, marginTop: 3, textTransform: "uppercase", letterSpacing: ".06em" }}>{data.project.statusMeaning}</div>
            </div>
            {!compact && <><Datum label="Category" value={data.project.appType} /><Datum label="Executor" value={data.project.executor} /><Datum label="Started" value={clock(data.project.startedAt)} /><Datum label="Elapsed" value={data.project.startedAt ? elapsed(Math.max(0, now - new Date(data.project.startedAt).getTime())) : "Waiting"} /></>}
            {compact && <span style={{ color: tone(data.project.status), fontSize: 10, ...mono }}>{elapsed(data.project.elapsedMs)}</span>}
          </div>

          {data.project.folderPath && !compact && <div style={{ color: "#94A3B8", fontSize: 10, ...mono, overflowWrap: "anywhere" }}>Folder · {data.project.folderPath}</div>}
          {data.project.stuck && <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(251,191,36,.3)", background: "rgba(251,191,36,.08)", color: "#FBBF24", fontSize: 11 }}>This build may be stuck. Last update was {data.project.minutesSinceUpdate} minutes ago.</div>}
          {data.worker.status === "offline" && <div style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(248,113,113,.3)", background: "rgba(248,113,113,.07)", color: "#FCA5A5", fontSize: 11 }}>Local Worker is offline. Turn on your PC or start worker.</div>}

          <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(7,minmax(16px,1fr))" : "repeat(auto-fit,minmax(118px,1fr))", gap: 6 }}>
            {data.timeline.map((item) => (
              <div key={item.key} title={`${item.label}: ${item.status}${item.timestamp ? ` at ${clock(item.timestamp)}` : ""}`} style={{ minWidth: 0, padding: compact ? "6px 3px" : "8px 9px", borderRadius: 7, border: `1px solid ${tone(item.status)}33`, background: `${tone(item.status)}0C` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 99, background: tone(item.status), flexShrink: 0 }} />{!compact && <span style={{ color: "#D8DEEB", fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>}</div>
                {!compact && <div style={{ color: tone(item.status), fontSize: 9, marginTop: 5, textTransform: "uppercase" }}>{item.status} · {clock(item.timestamp)}</div>}
              </div>
            ))}
          </div>

          {!compact && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(220px,.7fr)", gap: 10 }}>
              <div style={{ border: "1px solid rgba(93,111,143,.22)", borderRadius: 8, background: "rgba(5,10,19,.72)", overflow: "hidden" }}>
                <div style={{ padding: "8px 10px", borderBottom: "1px solid rgba(93,111,143,.18)", color: "#94A3B8", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase" }}>Live Logs</div>
                <div style={{ maxHeight: 290, overflow: "auto", padding: 8 }}>
                  {visibleLogs.map((log, index) => <div key={`${log.timestamp}-${index}`} style={{ display: "grid", gridTemplateColumns: "70px 90px minmax(0,1fr)", gap: 8, padding: "5px 4px", borderBottom: "1px solid rgba(93,111,143,.1)", fontSize: 10 }}><span style={{ color: "#4B5563", ...mono }}>{clock(log.timestamp)}</span><span style={{ color: tone(log.status), fontWeight: 800 }}>{log.source}</span><span style={{ color: "#CBD5E1", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{log.message}</span></div>)}
                  {!visibleLogs.length && <div style={{ color: "#647089", fontSize: 11, padding: 8 }}>No persisted build logs yet.</div>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <ConsoleCard title="Files Changed">
                  {data.files.length ? data.files.map((file) => <div key={file} style={{ color: "#CBD5E1", fontSize: 10, padding: "3px 0", ...mono, overflowWrap: "anywhere" }}>{file}</div>) : <Empty>No files recorded yet.</Empty>}
                </ConsoleCard>
                <ConsoleCard title="Preview">
                  {data.preview ? <><div style={{ color: tone(data.preview.status), fontSize: 10, marginBottom: 8 }}>Preview {data.preview.status}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}><a href={data.preview.url} target="_blank" rel="noopener" style={action}>Open Preview</a><button onClick={() => void copy(data.preview!.url, "url")} style={action}>{copied === "url" ? "Copied" : "Copy URL"}</button><button onClick={() => void openFolder()} style={action}>Open Folder</button></div>{data.preview.manualCommand && <><pre style={{ margin: "9px 0 0", padding: 8, borderRadius: 6, background: "#050A13", color: "#94A3B8", fontSize: 9, whiteSpace: "pre-wrap", ...mono }}>{data.preview.manualCommand}</pre><button onClick={() => void copy(data.preview!.manualCommand ?? "", "command")} style={{ ...action, marginTop: 6 }}>{copied === "command" ? "Command copied" : "Copy manual command"}</button></>} </> : <Empty>Preview has not started.</Empty>}
                </ConsoleCard>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Datum({ label, value }: { label: string; value: string }) { return <div><div style={{ color: "#4B5563", fontSize: 9, textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</div><div style={{ color: "#CBD5E1", fontSize: 10, marginTop: 3, whiteSpace: "nowrap" }}>{value}</div></div>; }
function ConsoleCard({ title, children }: { title: string; children: React.ReactNode }) { return <div style={{ border: "1px solid rgba(93,111,143,.22)", borderRadius: 8, background: "rgba(5,10,19,.58)", padding: 10 }}><div style={{ color: "#94A3B8", fontSize: 9, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 7 }}>{title}</div>{children}</div>; }
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ color: "#647089", fontSize: 10 }}>{children}</div>; }
const action: React.CSSProperties = { display: "inline-block", border: "1px solid rgba(96,165,250,.3)", background: "rgba(96,165,250,.1)", color: "#93C5FD", borderRadius: 6, padding: "6px 8px", fontSize: 9, fontWeight: 800, cursor: "pointer", textDecoration: "none" };
