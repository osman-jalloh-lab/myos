"use client";

import { useEffect, useRef, useState } from "react";

interface NousMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export default function HermesNousChatPanel() {
  const [messages, setMessages] = useState<NousMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [waitingTaskId, setWaitingTaskId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadMessages() {
    const res = await fetch("/api/hermes-nous/chat", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as { messages?: NousMessage[] };
    setMessages(data.messages ?? []);
  }

  useEffect(() => {
    void loadMessages();
  }, []);

  useEffect(() => {
    if (!waitingTaskId) return;
    const interval = setInterval(() => { void loadMessages(); }, 3500);
    return () => clearInterval(interval);
  }, [waitingTaskId]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (waitingTaskId && last?.role === "assistant") setWaitingTaskId(null);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, waitingTaskId]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { id: `pending-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() }]);
    try {
      const res = await fetch("/api/hermes-nous/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json().catch(() => null) as { userMessage?: NousMessage; taskId?: string; error?: string } | null;
      if (!res.ok || data?.error) throw new Error(data?.error ?? `Hermes Nous request failed with ${res.status}`);
      if (data?.userMessage) {
        setMessages((prev) => [...prev.filter((message) => !message.id.startsWith("pending-")), data.userMessage!]);
      }
      if (data?.taskId) setWaitingTaskId(data.taskId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Hermes Nous chat could not be queued.";
      setMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: "assistant", content: detail, createdAt: new Date().toISOString() }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={panel}>
      <div style={header}>
        <div style={terminalMark}>$</div>
        <div>
          <div style={eyebrow}>Hermes Nous runtime</div>
          <h3 style={title}>Direct CLI Chat</h3>
        </div>
        <div style={statusPill}>{waitingTaskId ? "queued" : "ready"}</div>
      </div>
      <div ref={scrollRef} style={scroll}>
        {messages.length === 0 ? (
          <div style={empty}>No Hermes Nous messages yet.</div>
        ) : (
          messages.map((message) => (
            <div key={message.id} style={{ ...row, justifyContent: message.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ ...bubble, ...(message.role === "user" ? userBubble : nousBubble) }}>{message.content}</div>
            </div>
          ))
        )}
        {waitingTaskId && (
          <div style={queuedLine}>Waiting for local worker task {waitingTaskId.slice(0, 8)}...</div>
        )}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={inputRow}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={sending}
          placeholder="Message Hermes Nous..."
          style={inputBox}
        />
        <button type="submit" disabled={sending || !input.trim()} style={sendButton}>{sending ? "..." : "Queue"}</button>
      </form>
    </div>
  );
}

const panel: React.CSSProperties = {
  border: "1px solid rgba(52,211,153,0.28)",
  background: "linear-gradient(180deg, rgba(6,18,16,0.72), rgba(8,13,24,0.76))",
  borderRadius: 8,
  overflow: "hidden",
  minHeight: 420,
  display: "flex",
  flexDirection: "column",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  borderBottom: "1px solid rgba(52,211,153,0.18)",
};

const terminalMark: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  display: "grid",
  placeItems: "center",
  background: "rgba(52,211,153,0.14)",
  color: "#34D399",
  border: "1px solid rgba(52,211,153,0.32)",
  font: "800 17px var(--mono)",
};

const eyebrow: React.CSSProperties = {
  color: "#7DD3FC",
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

const title: React.CSSProperties = {
  margin: "2px 0 0",
  color: "#F1F4FB",
  fontSize: 16,
  fontWeight: 850,
};

const statusPill: React.CSSProperties = {
  marginLeft: "auto",
  borderRadius: 999,
  padding: "4px 9px",
  border: "1px solid rgba(52,211,153,0.24)",
  color: "#86EFAC",
  background: "rgba(52,211,153,0.09)",
  fontSize: 11,
  fontWeight: 800,
};

const scroll: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const empty: React.CSSProperties = {
  color: "#94A3B8",
  fontSize: 12.5,
  lineHeight: 1.6,
  padding: "16px 4px",
};

const row: React.CSSProperties = { display: "flex" };

const bubble: React.CSSProperties = {
  maxWidth: "78%",
  borderRadius: 8,
  padding: "10px 12px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 12.5,
  lineHeight: 1.55,
};

const userBubble: React.CSSProperties = {
  color: "#F1F4FB",
  background: "rgba(125,211,252,0.12)",
  border: "1px solid rgba(125,211,252,0.22)",
};

const nousBubble: React.CSSProperties = {
  color: "#D8DEEB",
  background: "rgba(8,13,24,0.68)",
  border: "1px solid rgba(52,211,153,0.18)",
  fontFamily: "var(--mono)",
};

const queuedLine: React.CSSProperties = {
  color: "#86EFAC",
  fontSize: 11,
  fontFamily: "var(--mono)",
};

const inputRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 14,
  borderTop: "1px solid rgba(52,211,153,0.18)",
};

const inputBox: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "rgba(8,13,24,0.72)",
  border: "1px solid rgba(93,111,143,0.32)",
  color: "#F1F4FB",
  borderRadius: 8,
  padding: "10px 12px",
  outline: "none",
  fontSize: 12.5,
};

const sendButton: React.CSSProperties = {
  border: "1px solid rgba(52,211,153,0.35)",
  background: "rgba(52,211,153,0.14)",
  color: "#86EFAC",
  borderRadius: 8,
  padding: "0 16px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};
