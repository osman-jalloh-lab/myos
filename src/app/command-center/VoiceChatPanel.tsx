"use client";

import { useState } from "react";
import ChatPanel from "./ChatPanel";
import VoiceInput from "./VoiceInput";
import { VoiceState, VoiceIntentPreview, intentPreview } from "@/lib/voice";

interface VoiceChatPanelProps {
  initialMessages: {
    id: string;
    role: "user" | "assistant";
    content: string;
    channel?: string;
    createdAt: string;
  }[];
}

export default function VoiceChatPanel({ initialMessages }: VoiceChatPanelProps) {
  const [sending, setSending] = useState(false);
  const [lastVoiceState, setLastVoiceState] = useState<VoiceState | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const sendText = async (text: string) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error("Send failed");
    return res.json();
  };

  const sendVoice = async (text: string) => {
    setLastVoiceState("executing");
    const res = await fetch("/api/voice/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text, source: "dashboard:voice" }),
    });
    if (!res.ok) throw new Error("Voice execution failed");
    const data = await res.json();
    setLastResult(data.message ?? "Submitted.");
    setLastVoiceState("completed");
    return data;
  };

  const handleVoiceSubmit = async (text: string) => {
    if (sending) return;
    setSending(true);
    try {
      const preview = intentPreview(text);
      if (preview.risk !== "read") {
        await sendVoice(text);
      } else {
        await sendText(text);
        setLastVoiceState("completed");
      }
    } catch (error) {
      setLastVoiceState("failed");
      setLastResult(error instanceof Error ? error.message : "Voice execution failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <VoiceInput onSubmit={handleVoiceSubmit} busy={sending} />
      {(lastVoiceState === "completed" || lastVoiceState === "failed") && lastResult && (
        <div style={{ padding: "8px 10px", borderRadius: 9, border: `1px solid ${lastVoiceState === "failed" ? "rgba(248,113,113,0.35)" : "rgba(52,211,153,0.35)"}`, background: lastVoiceState === "failed" ? "rgba(248,113,113,0.1)" : "rgba(52,211,153,0.08)", color: lastVoiceState === "failed" ? "#F87171" : "#D8DEEB", fontSize: 12 }}>
          {lastResult}
        </div>
      )}
      <ChatPanel initialMessages={initialMessages} />
    </div>
  );
}
