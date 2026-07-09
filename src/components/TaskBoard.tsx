"use client";

import { useEffect, useState } from "react";
import { normalizeAgentKey } from "@/lib/agent-roster";

interface TaskView {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedAgent: string | null;
  createdAt: string;
}

const STATUS_COLOR: Record<string, string> = {
  open: "var(--faint)",
  in_progress: "var(--hermes)",
  done: "var(--plutus)",
};

/**
 * "Tasks assigned to {Agent}" — the orchestration audit trail made visible.
 * Lives inside each agent's private chat overlay; reuses the same /api/tasks
 * surface the natural-language "ask Athena to..." assignment branch writes to.
 */
export default function TaskBoard({ agentName, accentColor }: { agentName: string; accentColor: string }) {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const canonicalAgent = normalizeAgentKey(agentName);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks?agent=${encodeURIComponent(canonicalAgent)}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setTasks(data.tasks ?? []); })
      .catch(() => { if (!cancelled) setTasks([]); });
    return () => { cancelled = true; };
  }, [canonicalAgent]);

  if (tasks === null) return null;
  if (tasks.length === 0) return null;

  return (
    <div style={{ ...wrap, borderTopColor: `color-mix(in srgb, ${accentColor} 24%, var(--line))` }}>
      <div style={label}>TASKS ASSIGNED TO THIS AGENT</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {tasks.slice(0, 5).map((t) => (
          <div key={t.id} style={row}>
            <span style={{ ...chip, background: `color-mix(in srgb, ${STATUS_COLOR[t.status] ?? "var(--faint)"} 16%, transparent)`, color: STATUS_COLOR[t.status] ?? "var(--faint)" }}>
              {t.status.replace("_", " ")}
            </span>
            <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: "12px 14px", borderTop: "1px solid var(--line)",
  background: "rgba(255,255,255,.015)",
};

const label: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "1.4px",
  color: "var(--faint)", marginBottom: 8,
};

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const chip: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".3px",
  padding: "2px 7px", borderRadius: 6, flexShrink: 0, textTransform: "uppercase",
};
