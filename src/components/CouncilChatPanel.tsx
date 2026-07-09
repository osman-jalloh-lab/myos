"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type CouncilMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export default function CouncilChatPanel() {
  const [messages, setMessages] = useState<CouncilMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async () => {
    const res = await fetch("/api/council/chat", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json() as { messages?: CouncilMessage[] };
    setMessages(data.messages ?? []);
  }, []);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { id: `pending-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() }]);
    try {
      const res = await fetch("/api/council/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "council", message: text }),
      });
      const data = await res.json().catch(() => null) as { userMessage?: CouncilMessage; reply?: CouncilMessage; error?: string } | null;
      if (!res.ok || data?.error) throw new Error(data?.error ?? `Council request failed with ${res.status}`);
      if (data?.userMessage && data.reply) {
        setMessages((prev) => [...prev.filter((message) => !message.id.startsWith("pending-")), data.userMessage!, data.reply!]);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Council request could not be queued.";
      setMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: "assistant", content: detail, createdAt: new Date().toISOString() }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={panel}>
      <div style={header}>
        <div>
          <div style={eyebrow}>Council of Agents</div>
          <h3 style={title}>Whole-Council Debate</h3>
        </div>
          <div style={statusPill}>{sending ? "asking" : "all configured providers"}</div>
      </div>

      <div style={rail}>
        <div style={ruleBox}>
          Council mode calls every configured Council provider. Ollama cannot decide alone, and cost-conscious routing is not used here.
        </div>
      </div>

      <div ref={scrollRef} style={scroll}>
        {messages.length === 0 ? (
          <div style={empty}>No Council messages yet.</div>
        ) : messages.map((message) => (
          <div key={message.id} style={{ ...row, justifyContent: message.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ ...bubble, ...(message.role === "user" ? userBubble : councilBubble) }}>{message.content}</div>
          </div>
        ))}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={inputRow}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={sending}
          placeholder="Ask the Council..."
          style={inputBox}
        />
        <button type="submit" disabled={sending || !input.trim()} style={sendButton}>{sending ? "..." : "Send"}</button>
      </form>
    </div>
  );
}

const panel: React.CSSProperties = {
  border: "1px solid rgba(251,191,36,0.26)",
  background: "linear-gradient(180deg, rgba(24,19,8,0.68), rgba(8,13,24,0.78))",
  borderRadius: 8,
  overflow: "hidden",
  minHeight: 560,
  display: "flex",
  flexDirection: "column",
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  borderBottom: "1px solid rgba(251,191,36,0.18)",
};

const eyebrow: React.CSSProperties = {
  color: "#FBBF24",
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
  border: "1px solid rgba(251,191,36,0.24)",
  color: "#FCD34D",
  background: "rgba(251,191,36,0.09)",
  fontSize: 11,
  fontWeight: 800,
};

const rail: React.CSSProperties = { padding: "0 14px 10px" };

const ruleBox: React.CSSProperties = {
  border: "1px solid rgba(93,111,143,0.22)",
  background: "rgba(8,13,24,0.44)",
  color: "#94A3B8",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 11.5,
  lineHeight: 1.45,
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
  maxWidth: "86%",
  borderRadius: 8,
  padding: "10px 12px",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: 12.5,
  lineHeight: 1.55,
};

const userBubble: React.CSSProperties = {
  color: "#F1F4FB",
  background: "rgba(251,191,36,0.12)",
  border: "1px solid rgba(251,191,36,0.22)",
};

const councilBubble: React.CSSProperties = {
  color: "#D8DEEB",
  background: "rgba(8,13,24,0.68)",
  border: "1px solid rgba(251,191,36,0.18)",
};

const inputRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: 14,
  borderTop: "1px solid rgba(251,191,36,0.18)",
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
  border: "1px solid rgba(251,191,36,0.35)",
  background: "rgba(251,191,36,0.14)",
  color: "#FCD34D",
  borderRadius: 8,
  padding: "0 16px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};
