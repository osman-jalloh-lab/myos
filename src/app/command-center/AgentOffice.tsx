"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import CouncilChatPanel from "@/components/CouncilChatPanel";
import { agentOfficeIdentity, agentTextMatches } from "@/lib/agent-office";
import { CHAT_ROSTER_AGENTS, normalizeAgentKey, type CoreAgentKey } from "@/lib/agent-roster";
import { redactExecutionText } from "@/lib/execution-runs";

type AgentRun = { id: string; agentName: string; inputSummary: string | null; outputSummary: string | null; modelProvider: string | null; status: string; createdAt: string };
type Project = { id: string; projectName: string; status: string; canonicalStage: string; currentTask: string | null; latestInstruction: string | null; assignedAgent: string | null; updatedAt: string };
type QueueTask = { id: string; title: string; description: string; status: string; assignedExecutor: string; projectId: string | null; updatedAt: string; result: string | null; logs: string[] };
type Approval = { id: string; actionType: string; status: string; createdAt: string };
type Skill = { id: string; name: string; description: string; enabled: boolean; ownerAgents: string[]; safetyClass: string; requiredCapabilities: string[] };
type Memory = { memories: Array<{ id: string; fact: string; source: string | null; createdAt: string }>; recentMemoryUse?: Array<{ id: string; agentName: string | null; query: string; createdAt: string }> };
type Health = { executors: Array<{ name: string; status: string; lastRun: string | null; lastError: string | null; currentTask?: string | null }>; apiProviders: Array<{ provider: string; selectedModel?: string; roleLabel?: string; status: string }> };

type AgentOfficeProps = {
  agentId: CoreAgentKey;
  onAgentChange: (agent: CoreAgentKey) => void;
  onBack: () => void;
  onAssignTask: () => void;
  onOpenBuilder: () => void;
  onOpenConsole: () => void;
  runs: AgentRun[];
  projects: Project[];
  queue: { tasks: QueueTask[]; lastUpdated: string } | null;
  approvals: Approval[];
  skills: Skill[];
  memory: Memory | null;
  health: Health | null;
};

type OfficeTab = "overview" | "work" | "activity" | "skills" | "memory" | "permissions";
const tabs: Array<{ id: OfficeTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "work", label: "Work" }, { id: "activity", label: "Activity & Logs" },
  { id: "skills", label: "Skills & Tools" }, { id: "memory", label: "Memory / Context" }, { id: "permissions", label: "Permissions" },
];
const canonicalAgents = CHAT_ROSTER_AGENTS.filter((agent) => !String(agent.id).startsWith("council_"));

function ago(value: string | null): string {
  if (!value) return "No recorded activity";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

function statusTone(value: string): string {
  if (/failed|error|offline/i.test(value)) return "danger";
  if (/waiting|pending|blocked|stale/i.test(value)) return "warning";
  if (/complete|ready|online|available|passed/i.test(value)) return "success";
  return "info";
}

export default function AgentOffice(props: AgentOfficeProps) {
  const identity = agentOfficeIdentity(props.agentId);
  const [tab, setTab] = useState<OfficeTab>("overview");
  const [drafts, setDrafts] = useState<Partial<Record<CoreAgentKey, string>>>({});
  const [sending, setSending] = useState(false);
  const [chatResult, setChatResult] = useState<string | null>(null);
  const [activityQuery, setActivityQuery] = useState("");
  const [councilOpen, setCouncilOpen] = useState(false);
  const matchingRuns = useMemo(() => props.runs.filter((run) => agentTextMatches(props.agentId, run.agentName, run.inputSummary, run.outputSummary)), [props.agentId, props.runs]);
  const matchingTasks = useMemo(() => (props.queue?.tasks ?? []).filter((task) => agentTextMatches(props.agentId, task.assignedExecutor, task.title, task.description)), [props.agentId, props.queue]);
  const matchingProjects = useMemo(() => props.projects.filter((project) => props.agentId === "prometheus" || agentTextMatches(props.agentId, project.assignedAgent, project.currentTask, project.latestInstruction)), [props.agentId, props.projects]);
  const matchingSkills = props.skills.filter((skill) => skill.ownerAgents.some((owner) => agentTextMatches(props.agentId, owner)));
  const latestRun = matchingRuns[0] ?? null;
  const executor = props.health?.executors.find((item) => agentTextMatches(props.agentId, item.name)) ?? null;
  const availability = executor?.status ?? (latestRun?.status === "failed" ? "Degraded" : "Available");
  const currentWork = matchingTasks.find((task) => !/complete|failed|cancel/i.test(task.status)) ?? null;
  const pendingApprovals = props.approvals.filter((approval) => approval.status === "pending");
  const relevantApprovals = props.agentId === "hermes" ? pendingApprovals : pendingApprovals.filter((approval) => agentTextMatches(props.agentId, approval.actionType));
  const provider = latestRun?.modelProvider ?? props.health?.apiProviders.find((item) => agentTextMatches(props.agentId, item.roleLabel, item.provider))?.selectedModel ?? null;
  const draft = drafts[props.agentId] ?? "";

  const send = async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true); setChatResult(null);
    try {
      const prefix = props.agentId === "hermes" ? "" : `@${props.agentId} `;
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: `${prefix}${message}` }) });
      const data = await response.json().catch(() => null) as { reply?: { content?: string }; error?: string } | null;
      setChatResult(response.ok ? data?.reply?.content ?? "Request accepted." : data?.error ?? "The request could not be sent.");
      if (response.ok) setDrafts((value) => ({ ...value, [props.agentId]: "" }));
    } finally { setSending(false); }
  };

  const filteredRuns = matchingRuns.filter((run) => !activityQuery || `${run.inputSummary ?? ""} ${run.outputSummary ?? ""} ${run.status}`.toLowerCase().includes(activityQuery.toLowerCase()));

  return (
    <section className={`agent-office agent-office-${props.agentId}`} style={{ "--agent-accent": identity.accent } as React.CSSProperties} aria-labelledby="agent-office-title">
      <nav className="agent-office-breadcrumb" aria-label="Agent office breadcrumb">
        <button type="button" onClick={props.onBack}>← Back to Overview</button><span>Overview</span><i>/</i><span>Agent Network</span><i>/</i><strong>{identity.name}</strong>
        <label><span>Switch agent</span><select value={props.agentId} onChange={(event) => { props.onAgentChange(normalizeAgentKey(event.target.value) as CoreAgentKey); setTab("overview"); }}>
          {canonicalAgents.map((agent) => <option key={agent.id} value={normalizeAgentKey(agent.id)}>{agent.name}</option>)}
        </select></label>
      </nav>

      <div className="agent-office-hero">
        <div className="agent-office-environment" aria-hidden="true"><span/><i/><b/></div>
        <div className="agent-office-portrait">
          {identity.image ? <Image src={identity.image} alt={`${identity.name}, ${identity.role}`} width={260} height={260} priority /> : <span>{identity.name.slice(0, 1)}</span>}
        </div>
        <div className="agent-office-identity">
          <span>{identity.department} office</span><h1 id="agent-office-title">{identity.name}</h1><strong>{identity.role}</strong><p>{identity.purpose}</p>
          <div className="agent-office-actions"><button type="button" className="primary" onClick={() => document.getElementById("agent-office-chat")?.focus()}>Talk to {identity.name}</button><button type="button" onClick={props.onAssignTask}>Assign Task</button></div>
        </div>
        <aside className="agent-office-presence" aria-label="Agent status">
          <span className={`status ${statusTone(availability)}`}>{availability}</span><dl><div><dt>Last active</dt><dd>{ago(executor?.lastRun ?? latestRun?.createdAt ?? null)}</dd></div><div><dt>Source</dt><dd>{executor ? "Executor health" : latestRun ? "Agent run" : "No heartbeat recorded"}</dd></div><div><dt>Model / provider</dt><dd>{provider ?? "Not recorded"}</dd></div></dl>
        </aside>
      </div>

      <div className="agent-office-tabs" role="tablist" aria-label={`${identity.name} office sections`}>{tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>

      {tab === "overview" && <div className="agent-office-overview">
        <section className="agent-office-chat-card"><header><div><span>Primary interaction</span><h2>Talk to {identity.name}</h2></div><em>{availability}</em></header><label htmlFor="agent-office-chat">What should {identity.name} help with?</label><textarea id="agent-office-chat" value={draft} onChange={(event) => setDrafts((value) => ({ ...value, [props.agentId]: event.target.value }))} placeholder={`Ask ${identity.name} about ${identity.department.toLowerCase()} work…`} /><div className="agent-office-chat-actions"><span>Normal tools, policy, and approvals remain authoritative.</span><button type="button" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? "Working…" : `Send to ${identity.name}`}</button></div>{chatResult && <div className="agent-office-chat-result" role="status">{chatResult}</div>}</section>
        <div className="agent-office-overview-side">
          <section><span>Current work</span><h2>{currentWork?.title ?? executor?.currentTask ?? "No active assignment"}</h2><p>{currentWork?.description ?? "This agent is available for a new request."}</p>{props.agentId === "prometheus" && <button type="button" onClick={props.onOpenBuilder}>Open Builder Office</button>}</section>
          <section><span>Needs attention</span><h2>{relevantApprovals.length ? `${relevantApprovals.length} approval${relevantApprovals.length === 1 ? "" : "s"}` : latestRun?.status === "failed" ? "Recent run failed" : "Nothing urgent"}</h2><p>{relevantApprovals.length ? "Review the pending action before this agent can continue." : latestRun?.status === "failed" ? latestRun.outputSummary ?? "Inspect the recorded failure." : "No agent-specific attention item is currently recorded."}</p></section>
          <section><span>Recent activity</span><h2>{latestRun?.inputSummary ?? "No recent run"}</h2><p>{latestRun ? `${latestRun.status} · ${ago(latestRun.createdAt)}` : "Activity will appear after this agent runs."}</p><button type="button" onClick={() => setTab("activity")}>Open detailed logs</button></section>
        </div>
      </div>}

      {tab === "work" && <div className="agent-office-detail-grid"><OfficeList title="Tasks" empty="No matching tasks." items={matchingTasks.map((task) => ({ id: task.id, title: task.title, body: task.result ?? task.description, meta: `${task.status} · ${ago(task.updatedAt)}` }))}/><OfficeList title="Projects" empty="No matching projects." items={matchingProjects.map((project) => ({ id: project.id, title: project.projectName, body: project.currentTask ?? project.latestInstruction ?? "No current task", meta: `${project.canonicalStage} · ${ago(project.updatedAt)}` }))}/>{props.agentId === "prometheus" && <section className="agent-office-link-card"><span>Execution evidence</span><h2>Builder and Live Console</h2><p>Builder owns project actions. Live Console shows persisted execution evidence without duplicating it here.</p><div><button onClick={props.onOpenBuilder}>Builder Office</button><button onClick={props.onOpenConsole}>Open Live Console</button></div></section>}{props.agentId === "hermes" && <section className="agent-office-link-card"><span>Executive review</span><h2>Council access</h2><p>Open the existing reviewer council only when a multi-agent review is useful.</p><button type="button" onClick={() => setCouncilOpen((value) => !value)}>{councilOpen ? "Close Council" : "Open Council"}</button></section>}{props.agentId === "hermes" && councilOpen && <div className="agent-office-council"><CouncilChatPanel /></div>}</div>}

      {tab === "activity" && <section className="agent-office-activity"><header><div><span>Chronological evidence</span><h2>Activity & Logs</h2></div><label><span>Search activity</span><input value={activityQuery} onChange={(event) => setActivityQuery(event.target.value)} placeholder="Search actions or results" /></label></header>{filteredRuns.map((run) => <article key={run.id}><time>{new Date(run.createdAt).toLocaleString()}</time><div><strong>{run.inputSummary ?? run.agentName}</strong><p>{run.outputSummary ?? "No output summary recorded."}</p><span className={`status ${statusTone(run.status)}`}>{run.status}</span>{run.modelProvider && <em>Provider: {run.modelProvider}</em>}</div></article>)}{!filteredRuns.length && <p className="agent-office-empty">No matching activity was recorded.</p>}</section>}

      {tab === "skills" && <div className="agent-office-detail-grid"><OfficeList title="Skills" empty="No agent-owned skills are currently registered." items={matchingSkills.map((skill) => ({ id: skill.id, title: skill.name, body: skill.description, meta: `${skill.enabled ? "Enabled" : "Disabled"} · ${skill.safetyClass}` }))}/><section className="agent-office-link-card"><span>Tools</span><h2>Execution access</h2><p>{matchingSkills.flatMap((skill) => skill.requiredCapabilities).filter((value, index, array) => array.indexOf(value) === index).join(" · ") || "No tool grants are recorded in the loaded skill metadata."}</p></section><section className="agent-office-link-card"><span>Model / provider</span><h2>{provider ?? "Not recorded"}</h2><p>Provider identity is execution metadata. It does not change the agent’s identity or permissions.</p></section></div>}

      {tab === "memory" && <div className="agent-office-detail-grid"><OfficeList title="Relevant memory" empty="No accessible memory is associated with this office." items={(props.memory?.memories ?? []).filter((item) => agentTextMatches(props.agentId, item.fact, item.source)).slice(0, 12).map((item) => ({ id: item.id, title: item.fact, meta: `${item.source ?? "memory"} · ${ago(item.createdAt)}` }))}/><OfficeList title="Recent retrieval" empty="No recent retrieval was recorded for this agent." items={(props.memory?.recentMemoryUse ?? []).filter((item) => agentTextMatches(props.agentId, item.agentName)).map((item) => ({ id: item.id, title: item.query, meta: ago(item.createdAt) }))}/></div>}

      {tab === "permissions" && <div className="agent-office-permissions"><section><span>Trust boundary</span><h2>{identity.safetyLabel}</h2><p>{identity.readOnly ? "This office is presented as read-only. It cannot turn analysis into an external write by itself." : "Any write, destructive action, external communication, or consequential change remains governed by My OS policy and normal approvals."}</p></section><section><span>Allowed scope</span><h2>Existing registered tools only</h2><p>A conversation or taught workflow cannot invent a tool, expand filesystem scope, grant Docker access, or suppress an approval.</p></section><section><span>Processing</span><h2>{provider ? `Recorded provider: ${provider}` : "Provider not recorded"}</h2><p>Only safe execution metadata is displayed. Secrets, credentials, and raw authorization data are excluded.</p></section></div>}
    </section>
  );
}

function OfficeList({ title, empty, items }: { title: string; empty: string; items: Array<{ id: string; title: string; body?: string | null; meta?: string }> }) {
  return <section className="agent-office-list"><header><span>Recorded data</span><h2>{title}</h2></header>{items.map((item) => <article key={item.id}><strong>{redactExecutionText(item.title, 500)}</strong>{item.body && <p>{redactExecutionText(item.body, 2000)}</p>}{item.meta && <small>{redactExecutionText(item.meta, 300)}</small>}</article>)}{!items.length && <p className="agent-office-empty">{empty}</p>}</section>;
}
