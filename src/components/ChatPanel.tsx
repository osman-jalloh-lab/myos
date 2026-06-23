"use client";

import { useEffect, useRef, useState } from "react";

interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: "dashboard" | "telegram";
  targetAgent: string | null;
  createdAt: string;
}

export interface ChatPanelProps {
  /** Agent key (e.g. "kairos"). Omit for the general Hermes thread. */
  agentName?: string;
  /** Display name shown in placeholder/empty-state copy. Defaults to "Hermes". */
  displayName?: string;
  /** CSS color var (e.g. "var(--kairos)") used for the user-bubble accent. Defaults to Hermes gold. */
  accentColor?: string;
  /** Empty-state copy tailored to the agent's domain. */
  emptyStateText?: React.ReactNode;
  /** Fixed panel height in px. Omit to flex-fill the parent (e.g. inside a slide-over). */
  height?: number;
}

/**
 * Talk to Hermes — or, when `agentName` is set, talk to that agent directly
 * in its own private thread. Either way this posts to /api/chat, which routes
 * server-side through Hermes.routeMessage() (general) or Hermes.routeToAgent()
 * (per-agent) — same approval-queue gating, same read-only data lookups. This
 * panel is a thin client; all routing/intent logic lives server-side in one place.
 */
export default function ChatPanel({ agentName, displayName = "Hermes", accentColor = "var(--hermes)", emptyStateText, height }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoaded(false);
    const qs = agentName ? `?agent=${encodeURIComponent(agentName)}` : "";
    fetch(`/api/chat${qs}`)
      .then((r) => r.json())
      .then((data) => setMessages(data.messages ?? []))
      .finally(() => setLoaded(true));
  }, [agentName]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `pending-${Date.now()}`, role: "user", content: text, channel: "dashboard", targetAgent: agentName ?? null, createdAt: new Date().toISOString() },
    ]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, ...(agentName ? { agentName } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as {
        userMessage?: ChatMessageView;
        reply?: ChatMessageView;
        error?: string;
      } | null;
      if (!res.ok || !data || data.error) {
        throw new Error(data?.error ?? `Chat request failed with ${res.status}`);
      }
      if (data.userMessage && data.reply) {
        const userMessage = data.userMessage;
        const reply = data.reply;
        setMessages((prev) => [...prev.filter((m) => !m.id.startsWith("pending-")), userMessage, reply]);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : `Couldn't reach ${displayName} - check your connection and try again.`;
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "assistant", content: detail, channel: "dashboard", targetAgent: agentName ?? null, createdAt: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="glass-panel" style={height ? { ...wrap, height } : { ...wrap, flex: 1, minHeight: 0 }}>
      <div ref={scrollRef} style={scroll}>
        {!loaded ? (
          <p style={{ fontSize: 12, color: "var(--faint)" }}>Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
            {emptyStateText ?? (
              <>
                Ask Hermes about your calendar, inbox, spend, job pipeline, memory, or pending
                approvals — it pulls real data and replies. Type <code style={{ fontFamily: "var(--mono)" }}>approve &lt;id&gt;</code> or{" "}
                <code style={{ fontFamily: "var(--mono)" }}>reject &lt;id&gt;</code> to act on a queued item, same as the{" "}
                <a href="/approvals" style={{ color: "var(--hermes)" }}>/approvals</a> page.
              </>
            )}
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} style={{ ...bubbleRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ ...bubble, ...(m.role === "user" ? { ...userBubble, background: `color-mix(in srgb, ${accentColor} 16%, transparent)` } : assistantBubble) }}>
                {m.content}
              </div>
            </div>
          ))
        )}
      </div>
      <div style={inputRow}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${displayName}…`}
          style={inputBox}
          disabled={sending}
        />
        <button onClick={send} disabled={sending || !input.trim()} style={{ ...sendBtn, background: accentColor }}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  borderRadius: 14, display: "flex", flexDirection: "column",
  overflow: "hidden",
};

const scroll: React.CSSProperties = {
  flex: 1, overflowY: "auto", padding: "16px 18px",
  display: "flex", flexDirection: "column", gap: 8,
};

const bubbleRow: React.CSSProperties = { display: "flex" };

const bubble: React.CSSProperties = {
  maxWidth: "78%", padding: "9px 13px", borderRadius: 12,
  fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap",
};

const userBubble: React.CSSProperties = {
  color: "var(--text)",
  borderBottomRightRadius: 3,
};

const assistantBubble: React.CSSProperties = {
  background: "var(--bg)", border: "1px solid var(--line)", color: "var(--text)",
  borderBottomLeftRadius: 3,
};

const inputRow: React.CSSProperties = {
  display: "flex", gap: 8, padding: "12px 14px",
  borderTop: "1px solid var(--line)",
};

const inputBox: React.CSSProperties = {
  flex: 1, background: "var(--bg)", border: "1px solid var(--line)",
  borderRadius: 9, padding: "9px 12px", fontSize: 12.5,
  color: "var(--text)", outline: "none",
};

const sendBtn: React.CSSProperties = {
  color: "#1a1410", border: "none",
  borderRadius: 9, padding: "0 18px", fontSize: 12.5, fontWeight: 600,
  cursor: "pointer",
};
