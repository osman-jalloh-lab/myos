"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createVoiceController, isSpeechRecognitionAvailable, VoiceState, VoiceIntentPreview, intentPreview, requiresApproval, canAutoReply } from "@/lib/voice";

function statusColor(state: VoiceState): string {
  switch (state) {
    case "listening":
      return "#F87171";
    case "processing":
      return "#A78BFA";
    case "transcript_ready":
    case "needs_approval":
      return "#34D399";
    case "executing":
    case "completed":
      return "#60A5FA";
    case "failed":
    case "unsupported":
      return "#FBBF24";
    default:
      return "#94A3B8";
  }
}

function statusLabel(state: VoiceState): string {
  return state.replace(/_/g, " ");
}

export function VoiceInput({ onSubmit, busy }: { onSubmit: (text: string) => Promise<void>; busy: boolean }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [editable, setEditable] = useState("");
  const [preview, setPreview] = useState<VoiceIntentPreview | null>(null);
  const controllerRef = useRef<ReturnType<typeof createVoiceController> | null>(null);
  const [muted, setMuted] = useState(true);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
  }, [controllerRef]);

  const reset = useCallback(() => {
    controllerRef.current?.reset();
    setTranscript("");
    setInterim("");
    setEditable("");
    setPreview(null);
  }, [controllerRef]);

  const submit = useCallback(async () => {
    const text = editable.trim();
    if (!text) return;
    const nextPreview = intentPreview(text);
    setPreview(nextPreview);

    if (nextPreview.risk !== "read") {
      setState("needs_approval");
      return;
    }

    setState("executing");
    try {
      await onSubmit(text);
      setState("completed");
    } catch {
      setState("failed");
    } finally {
      setTimeout(() => reset(), 2000);
    }
  }, [editable, onSubmit, reset]);

  const approveAndRun = useCallback(async () => {
    setState("executing");
    try {
      await onSubmit(editable.trim());
      setState("completed");
    } catch {
      setState("failed");
    } finally {
      setTimeout(() => reset(), 2000);
    }
  }, [editable, onSubmit, reset]);

  useEffect(() => {
    const controller = createVoiceController((final, interimText) => {
      setTranscript(final);
      setInterim(interimText);
      setEditable(final);
      setPreview(intentPreview(final));
      setState("transcript_ready");
    });
    controllerRef.current = controller;

    if (!controller) {
      setState("unsupported");
      return;
    }

    const unsub = controller.getState;
    // state read only
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const update = (s: VoiceState) => setState(s);
    // local listener set not exposed; use polling fallback
    const id = setInterval(() => update(controller.getState()), 150);
    return () => clearInterval(id);
  }, [controllerRef]);

  const isListening = state === "listening";
  const isReady = state === "transcript_ready" || state === "needs_approval";
  const isUnsupported = state === "unsupported";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy || isUnsupported}
          onClick={async () => {
            if (isListening) {
              stop();
            } else {
              if (controllerRef.current) controllerRef.current.start();
            }
          }}
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            border: `1px solid ${isListening ? "#F87171" : "#A78BFA"}55`,
            background: isListening ? "rgba(248,113,113,0.14)" : "rgba(167,139,250,0.12)",
            color: isListening ? "#F87171" : "#C4B5FD",
            fontSize: 12,
            fontWeight: 800,
            cursor: busy || isUnsupported ? "not-allowed" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: statusColor(state), boxShadow: `0 0 12px ${statusColor(state)}88` }} />
          {isListening ? "Stop" : isUnsupported ? "Voice unavailable" : "Push to talk"}
        </button>

        <span style={{ color: "#94A3B8", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {statusLabel(state)}
        </span>

        <button
          type="button"
          onClick={() => {
            if (muted) {
              setMuted(false);
            } else {
              setMuted(true);
              import("@/lib/voice").then((m) => m.stopSpeaking());
            }
          }}
          style={{
            marginLeft: "auto",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #28324A",
            background: muted ? "rgba(8,13,24,0.44)" : "rgba(96,164,250,0.15)",
            color: muted ? "#94A3B8" : "#60A5FA",
            fontSize: 11,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {muted ? "Muted" : "TTS on"}
        </button>
      </div>

      {(transcript || isReady) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: "#94A3B8", fontSize: 12, fontWeight: 700 }}>I heard:</div>
          <textarea
            value={editable}
            onChange={(e) => setEditable(e.target.value)}
            rows={3}
            disabled={busy}
            style={{
              width: "100%",
              background: "rgba(8,13,24,0.62)",
              border: "1px solid #28324A",
              borderRadius: 10,
              padding: "9px 12px",
              color: "#F1F4FB",
              fontSize: 12,
              resize: "vertical",
              outline: "none",
              fontFamily: "inherit",
              opacity: busy ? 0.7 : 1,
            }}
          />

          {preview && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ color: "#94A3B8", fontSize: 11, fontWeight: 700 }}>Planned action:</span>
              <span style={{ color: "#D8DEEB", fontSize: 12 }}>{preview.summary}</span>
              <span style={{ padding: "3px 9px", borderRadius: 999, border: "1px solid #28324A", color: preview.risk === "read" ? "#34D399" : "#FBBF24", fontSize: 11, fontWeight: 700 }}>
                {preview.risk === "read" ? "Read-only" : "Write/action"}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            {requiresApproval(state, preview ?? intentPreview(editable)) ? (
              <button
                type="button"
                disabled={busy}
                onClick={approveAndRun}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(52,211,153,0.15)",
                  border: "1px solid rgba(52,211,153,0.38)",
                  color: "#34D399",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Approve and run
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={submit}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(96,165,250,0.15)",
                  border: "1px solid rgba(96,165,250,0.3)",
                  color: "#60A5FA",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Send
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                background: "rgba(248,113,113,0.1)",
                border: "1px solid rgba(248,113,113,0.3)",
                color: "#F87171",
                fontSize: 12,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
