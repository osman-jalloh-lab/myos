"use client";

import { useState, useEffect, useRef } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel?: string;
  createdAt: string;
}

const cardStyle: React.CSSProperties = {
  background: "rgba(26, 35, 54, 0.85)",
  border: "1px solid #28324A",
  borderRadius: 16,
  backdropFilter: "blur(12px)",
  padding: "20px 24px",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ChatPanel({ initialMessages }: { initialMessages: ChatMessage[] }) {
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
    setMessages((prev) => [...prev, { id: `tmp-${Date.now()}`, role: "user", content: text, channel: "dashboard", createdAt: new Date().toISOString() }]);

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      if (res.ok) {
        const data = await res.json() as { reply?: { content?: string }; userMessage?: { id?: string } };
        const reply = data.reply;
        if (reply?.content) {
          setMessages((prev) => [...prev, { id: `reply-${Date.now()}`, role: "assistant", content: String(reply.content ?? ""), channel: "dashboard", createdAt: new Date().toISOString() }]);
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
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#A78BFA", fontWeight: 700, flexShrink: 0 }}>H</div>
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
                }}>{m.content}</div>
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

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={{ marginTop: 16, display: "flex", gap: 10 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
          disabled={sending}
          placeholder="Message Hermes... (Ctrl/Cmd + Enter to send)"
          rows={2}
          style={{
            flex: 1, background: "rgba(14,20,36,0.6)", border: "1px solid #28324A", borderRadius: 12, padding: "10px 14px",
            color: "#F1F4FB", fontSize: 13, resize: "vertical", outline: "none", fontFamily: "inherit", opacity: sending ? 0.7 : 1,
          }}
        />
        <button
          type="submit"
          disabled={sending}
          style={{
            padding: "0 20px", borderRadius: 12, background: "rgba(167,139,250,0.15)",
            border: "1px solid rgba(167,139,250,0.3)", color: "#A78BFA", fontWeight: 600,
            fontSize: 13, cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.5 : 1,
          }}
        >{sending ? "..." : "Send"}</button>
      </form>
    </div>
  );
}
