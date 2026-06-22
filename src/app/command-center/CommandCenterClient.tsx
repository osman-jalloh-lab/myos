"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import BuilderOffice from "./BuilderOffice";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  assignedAgent: string | null;
  nextStep: string | null;
}

interface Project {
  id: string;
  projectName: string;
  description: string | null;
  route: string | null;
  status: string;
  latestInstruction: string | null;
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

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel?: string;
  createdAt: string;
}

type Tab = "overview" | "agents" | "projects" | "builds" | "logs" | "chat";

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

function statusColor(status: string): string {
  switch (status) {
    case "active": case "completed": case "done": case "deployed": return "#34D399";
    case "planning": case "approved": case "queued": return "#60A5FA";
    case "in_progress": case "building": case "running": case "implementation_running": case "validation_running": return "#A78BFA";
    case "blocked": case "failed": return "#F87171";
    default: return "#94A3B8";
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function approvalLabel(action: ApprovalAction): string {
  try {
    const p = action.payload as Record<string, unknown>;
    if (action.actionType === "engineering_plan") return `Build plan: ${String(p.projectName ?? "").slice(0, 50)}`;
    if (action.actionType === "save_memory") return `Remember: "${String(p.fact ?? "").slice(0, 50)}"`;
    if (action.actionType === "create_task") return `Task: "${String(p.title ?? "").slice(0, 50)}"`;
    return action.actionType.replace(/_/g, " ");
  } catch {
    return action.actionType;
  }
}

const AGENT_COLORS: Record<string, string> = {
  hermes: "#A78BFA", iris: "#F472B6", kairos: "#34D399",
  argus: "#60A5FA", plutus: "#FBBF24", athena: "#E879F9",
  mnemosyne: "#2DD4BF", sophos: "#FB923C", themis: "#F43F5E",
  prometheus: "#38BDF8",
};

// ── Card & layout primitives ──────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: "rgba(26, 35, 54, 0.85)",
  border: "1px solid #28324A",
  borderRadius: 16,
  backdropFilter: "blur(12px)",
  padding: "20px 24px",
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  padding: "6px 16px",
  borderRadius: 999,
  fontSize: 13,
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
  projects, approvals, builds, onApprove, onReject, onTabSwitch,
}: {
  projects: Project[];
  approvals: ApprovalAction[];
  builds: Build[];
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onTabSwitch: (tab: Tab) => void;
}) {
  const active = projects.filter((p) => ["active", "building"].includes(p.status));
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const runningBuilds = builds.filter((b) => ["running", "queued"].includes(b.status));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Metric row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {[
          { label: "Active Projects", value: active.length, color: "#34D399", tab: "projects" as Tab },
          { label: "Pending Approvals", value: pendingApprovals.length, color: pendingApprovals.length > 0 ? "#FBBF24" : "#94A3B8", tab: "overview" as Tab },
          { label: "Running Builds", value: runningBuilds.length, color: "#A78BFA", tab: "builds" as Tab },
        ].map((m) => (
          <button
            key={m.label}
            onClick={() => m.tab !== "overview" && onTabSwitch(m.tab)}
            style={{
              ...cardStyle,
              textAlign: "left",
              cursor: m.tab !== "overview" ? "pointer" : "default",
              padding: "20px 24px",
            }}
          >
            <div style={{ fontSize: 32, fontWeight: 700, color: m.color, fontFamily: "Fraunces, serif" }}>
              {m.value}
            </div>
            <div style={{ fontSize: 13, color: "#94A3B8", marginTop: 4 }}>{m.label}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Pending Approvals */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Pending Approvals
          </div>
          {pendingApprovals.length === 0 ? (
            <div style={{ color: "#4B5563", fontSize: 13 }}>No pending approvals</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pendingApprovals.slice(0, 5).map((a) => (
                <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 13, color: "#F1F4FB" }}>{approvalLabel(a)}</div>
                  <div style={{ fontSize: 11, color: "#94A3B8" }}>{timeAgo(a.createdAt)}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => onApprove(a.id)}
                      style={{ flex: 1, padding: "6px 0", borderRadius: 8, background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.4)", color: "#34D399", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onReject(a.id)}
                      style={{ flex: 1, padding: "6px 0", borderRadius: 8, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "#F87171", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Projects Summary */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Active Projects
          </div>
          {active.length === 0 ? (
            <div style={{ color: "#4B5563", fontSize: 13 }}>No active projects</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {active.slice(0, 3).map((p) => (
                <div key={p.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 14, color: "#F1F4FB", fontWeight: 500 }}>{p.projectName}</span>
                    <span style={badgeStyle(statusColor(p.status))}>{statusLabel(p.status)}</span>
                  </div>
                  <ProgressBar done={p.taskCounts.done} total={p.taskCounts.total} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Builds */}
      {builds.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#94A3B8", marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Recent Builds
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {builds.slice(0, 4).map((b) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "rgba(40,50,74,0.4)", borderRadius: 10 }}>
                <span style={badgeStyle(statusColor(b.status))}>{statusLabel(b.status)}</span>
                <span style={{ flex: 1, fontSize: 13, color: "#F1F4FB", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</span>
                {b.pullRequestUrl && (
                  <a href={b.pullRequestUrl} target="_blank" rel="noopener" style={{ fontSize: 11, color: "#60A5FA", textDecoration: "none" }}>PR</a>
                )}
                {b.deploymentUrl && (
                  <a href={b.deploymentUrl} target="_blank" rel="noopener" style={{ fontSize: 11, color: "#34D399", textDecoration: "none" }}>Live</a>
                )}
                <span style={{ fontSize: 11, color: "#94A3B8" }}>{timeAgo(b.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Projects panel ────────────────────────────────────────────────────────────

function ProjectsPanel({ projects }: { projects: Project[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
                        <span style={{ fontSize: 11, color: AGENT_COLORS[t.assignedAgent] ?? "#94A3B8" }}>{t.assignedAgent}</span>
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
            const color = AGENT_COLORS[r.agentName] ?? "#94A3B8";
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

function ChatPanel({ initialMessages }: { initialMessages: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);

    const userMsg: ChatMessage = { id: `tmp-${Date.now()}`, role: "user", content: text, channel: "dashboard", createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      if (res.ok) {
        const data = await res.json() as { reply?: { content?: string }; userMessage?: { id?: string } };
        if (data.reply?.content) {
          const assistantMsg: ChatMessage = { id: `reply-${Date.now()}`, role: "assistant", content: data.reply.content, channel: "dashboard", createdAt: new Date().toISOString() };
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

      <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Message Hermes... (Enter to send, Shift+Enter for newline)"
          rows={2}
          style={{
            flex: 1, background: "rgba(14,20,36,0.6)", border: "1px solid #28324A", borderRadius: 12, padding: "10px 14px",
            color: "#F1F4FB", fontSize: 13, resize: "none", outline: "none", fontFamily: "inherit",
          }}
        />
        <button
          onClick={() => void send()}
          disabled={!input.trim() || sending}
          style={{
            padding: "0 20px", borderRadius: 12, background: "rgba(167,139,250,0.15)",
            border: "1px solid rgba(167,139,250,0.3)", color: "#A78BFA", fontWeight: 600,
            fontSize: 13, cursor: !input.trim() || sending ? "not-allowed" : "pointer",
            opacity: !input.trim() || sending ? 0.5 : 1,
          }}
        >
          {sending ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CommandCenterClient() {
  const [tab, setTab] = useState<Tab>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [approvals, setApprovals] = useState<ApprovalAction[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [projRes, buildsRes, approvalsRes, logsRes, chatRes, tgChatRes] = await Promise.allSettled([
        fetch("/api/command-center/projects").then((r) => r.json() as Promise<{ projects: Project[] }>),
        fetch("/api/command-center/builds").then((r) => r.json() as Promise<{ builds: Build[] }>),
        fetch("/api/approvals").then((r) => r.json() as Promise<{ actions: ApprovalAction[] }>),
        fetch("/api/command-center/logs").then((r) => r.json() as Promise<{ runs: AgentRun[]; audit: AuditEntry[] }>),
        fetch("/api/chat").then((r) => r.json() as Promise<{ messages: ChatMessage[] }>),
        fetch("/api/chat?channel=telegram").then((r) => r.json() as Promise<{ messages: ChatMessage[] }>),
      ]);

      if (projRes.status === "fulfilled") setProjects(projRes.value.projects ?? []);
      if (buildsRes.status === "fulfilled") setBuilds(buildsRes.value.builds ?? []);
      if (approvalsRes.status === "fulfilled") setApprovals(approvalsRes.value.actions ?? []);
      if (logsRes.status === "fulfilled") {
        setRuns(logsRes.value.runs ?? []);
        setAudit(logsRes.value.audit ?? []);
      }

      const webMsgs = chatRes.status === "fulfilled" ? (chatRes.value.messages ?? []).map((m) => ({ ...m, channel: "dashboard" })) : [];
      const tgMsgs = tgChatRes.status === "fulfilled" ? (tgChatRes.value.messages ?? []).map((m) => ({ ...m, channel: "telegram" })) : [];
      const merged = [...webMsgs, ...tgMsgs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      setChatMessages(merged);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
    const interval = setInterval(() => { void fetchAll(); }, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleApprove = async (id: string) => {
    await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    void fetchAll();
  };

  const handleReject = async (id: string) => {
    await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject" }) });
    void fetchAll();
  };

  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  return (
    <div style={{ minHeight: "100vh", background: "var(--cc-bg-page, #0E1424)", color: "var(--cc-fg-primary, #F1F4FB)", fontFamily: "Hanken Grotesk, sans-serif" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #28324A", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/" style={{ fontSize: 12, color: "#94A3B8", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
            <span>←</span> Dashboard
          </a>
          <div style={{ width: 1, height: 20, background: "#28324A" }} />
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "Fraunces, serif", color: "#A78BFA" }}>
            Agent Control Center
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#4B5563" }}>
          {loading && <span>Syncing...</span>}
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
          <span>Live</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: "0 32px", borderBottom: "1px solid #28324A", display: "flex", gap: 8, height: 52, alignItems: "center" }}>
        {(["overview", "agents", "projects", "builds", "logs", "chat"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={pillStyle(tab === t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === "overview" && pendingCount > 0 && (
              <span style={{ marginLeft: 6, background: "#FBBF24", color: "#0E1424", borderRadius: 999, padding: "0 5px", fontSize: 10, fontWeight: 800 }}>
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>
        {loading && projects.length === 0 ? (
          <div style={{ textAlign: "center", color: "#4B5563", padding: 64 }}>Loading...</div>
        ) : (
          <>
            {tab === "overview" && (
              <OverviewPanel projects={projects} approvals={approvals} builds={builds} onApprove={handleApprove} onReject={handleReject} onTabSwitch={setTab} />
            )}
            {tab === "agents" && <BuilderOffice />}
            {tab === "projects" && <ProjectsPanel projects={projects} />}
            {tab === "builds" && <BuildsPanel builds={builds} />}
            {tab === "logs" && <LogsPanel runs={runs} audit={audit} />}
            {tab === "chat" && <ChatPanel initialMessages={chatMessages} />}
          </>
        )}
      </div>
    </div>
  );
}
