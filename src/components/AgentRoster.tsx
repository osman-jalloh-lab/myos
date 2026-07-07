"use client";

import { useState } from "react";
import ChatPanel from "./ChatPanel";
import TaskBoard from "./TaskBoard";

export interface RosterAgent {
  id: string;
  letter: string;
  name: string;
  role: string;
  color: string;
}

const AGENT_EMPTY_STATE: Record<string, string> = {
  hermes: "Talk to Hermes — the orchestrator. Ask for anything; it routes to the right agent or answers itself.",
  iris: "Ask Iris about your inbox — unread counts, what needs a reply, or to draft a response (drafts only, never sends).",
  kairos: "Ask Kairos about your week — what's on the calendar, scheduling conflicts, or where to block focus time.",
  argus: "Ask Argus what's worth your attention today — synthesized signals and risk-flagged items across your accounts.",
  plutus: "Ask Plutus about your money — net position, budget status, or debt tracking (read-only, never moves money).",
  athena: "Ask Athena about your job search — pipeline status, fit scores, or what to tighten on your resume.",
  mnemo: "Ask Mnemosyne what it remembers — approved facts and context cards relevant to what you're working on.",
  sophos: "Ask Sophos what's new — recent Anthropic releases or repos worth a look for your stack.",
  tyche: "Ask Tyche about income opportunities — side income leads, gigs, and what's worth your hours right now.",
  themis: "Ask Themis about work and I-9 questions — answers grounded only in your loaded workplace knowledge files.",
  prometheus: "Ask Prometheus to build something — an idea, a website, an app. It can push builds live to GitHub Pages.",
};

const AGENT_KEY: Record<string, string> = { mnemo: "mnemosyne" };

// The Hermes card targets the general thread — ChatPanel omits the agent
// param entirely so the message goes through routeMessage(), not routeToAgent().
function chatAgentName(id: string): string | undefined {
  return id === "hermes" ? undefined : AGENT_KEY[id] ?? id;
}

export default function AgentRoster({ agents }: { agents: RosterAgent[] }) {
  const [openAgent, setOpenAgent] = useState<RosterAgent | null>(null);

  return (
    <>
      {agents.map((a) => (
        <button
          key={a.id}
          onClick={() => setOpenAgent(a)}
          className={`glass-interactive glow-${a.id}${openAgent?.id === a.id ? " is-active" : ""}`}
          style={{ ...agentRow, cursor: "pointer", borderRadius: 12 }}
        >
          <div style={{ ...av, background: `color-mix(in srgb, ${a.color} 16%, transparent)`, color: a.color, position: "relative" }}>
            {a.letter}
            <span style={{ ...dot, background: "var(--plutus)", animation: "blip 2.6s infinite" }} />
          </div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>{a.name}</div>
            <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 1 }}>{a.role}</div>
          </div>
        </button>
      ))}

      {openAgent && (
        <div style={overlayBackdrop} onClick={() => setOpenAgent(null)}>
          <div className="glass-panel" style={overlayPanel} onClick={(e) => e.stopPropagation()}>
            <div style={overlayHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={{ ...av, background: `color-mix(in srgb, ${openAgent.color} 18%, transparent)`, color: openAgent.color }}>
                  {openAgent.letter}
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: openAgent.color }}>{openAgent.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--faint)" }}>{openAgent.role} · private thread</div>
                </div>
              </div>
              <button onClick={() => setOpenAgent(null)} style={closeBtn}>✕</button>
            </div>
            <div style={{ padding: 14, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 0 }}>
              <ChatPanel
                agentName={chatAgentName(openAgent.id)}
                displayName={openAgent.name}
                accentColor={openAgent.color}
                emptyStateText={AGENT_EMPTY_STATE[openAgent.id]}
              />
            </div>
            <TaskBoard agentName={AGENT_KEY[openAgent.id] ?? openAgent.id} accentColor={openAgent.color} />
          </div>
        </div>
      )}
    </>
  );
}

const agentRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 11, width: "100%",
  padding: "8px 10px", borderRadius: 12, marginBottom: 1,
  background: "transparent", border: "none", color: "inherit", font: "inherit",
  transition: "background .15s ease, transform .15s ease",
};

const av: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 9, flexShrink: 0,
  display: "grid", placeItems: "center",
  fontFamily: "var(--serif)", fontSize: 14, fontWeight: 600,
};

const dot: React.CSSProperties = {
  position: "absolute", right: -2, bottom: -2,
  width: 9, height: 9, borderRadius: "50%",
  border: "2px solid #0a0a0d",
};

const overlayBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(6,6,8,.6)",
  backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
  display: "flex", justifyContent: "flex-end", zIndex: 100,
};

const overlayPanel: React.CSSProperties = {
  width: "min(480px, 92vw)", height: "100dvh",
  background: "linear-gradient(180deg, rgba(14,14,18,.78), rgba(10,10,13,.86))",
  display: "flex", flexDirection: "column",
  boxShadow: "-24px 0 64px rgba(0,0,0,.45)",
  borderRadius: 0,
};

const overlayHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "16px 18px", borderBottom: "1px solid var(--line)",
};

const closeBtn: React.CSSProperties = {
  background: "rgba(255,255,255,.05)", border: "1px solid var(--line)",
  borderRadius: 8, color: "var(--muted)", width: 28, height: 28,
  display: "grid", placeItems: "center", cursor: "pointer", fontSize: 12,
};
