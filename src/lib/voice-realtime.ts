export const HERMES_VOICE_STATES = ["idle", "connecting", "listening", "thinking", "council", "executing", "speaking", "muted", "blocked", "error"] as const;
export type HermesVoiceState = typeof HERMES_VOICE_STATES[number];
export type VoiceFailureCategory = "permission_denied" | "realtime_unavailable" | "provider_unavailable" | "unsupported_browser" | "network_unavailable" | "audio_blocked" | "session_expired" | "hermes_unavailable";
export type VoiceAction = { type: "CONNECT" | "READY" | "TRANSCRIPT" | "COUNCIL" | "EXECUTING" | "SPEAK" | "MUTE" | "UNMUTE" | "STOP" } | { type: "FAIL"; category: VoiceFailureCategory };
export type VoiceMachine = { state: HermesVoiceState; active: boolean; muted: boolean; error: VoiceFailureCategory | null };
export const INITIAL_VOICE_MACHINE: VoiceMachine = { state: "idle", active: false, muted: false, error: null };
export function reduceVoiceState(current: VoiceMachine, action: VoiceAction): VoiceMachine {
  switch (action.type) {
    case "CONNECT": return { state: "connecting", active: true, muted: false, error: null };
    case "READY": return { ...current, state: current.muted ? "muted" : "listening", active: true, error: null };
    case "TRANSCRIPT": return { ...current, state: "thinking", active: true, error: null };
    case "COUNCIL": return { ...current, state: "council", active: true };
    case "EXECUTING": return { ...current, state: "executing", active: true };
    case "SPEAK": return { ...current, state: "speaking", active: true, error: null };
    case "MUTE": return { ...current, state: "muted", muted: true };
    case "UNMUTE": return { ...current, state: current.active ? "listening" : "idle", muted: false };
    case "STOP": return INITIAL_VOICE_MACHINE;
    case "FAIL": return { ...current, state: "error", active: false, error: action.category };
  }
}
export const VOICE_ERROR_COPY: Record<VoiceFailureCategory, string> = { permission_denied: "Microphone permission denied", realtime_unavailable: "Realtime connection unavailable", provider_unavailable: "Voice provider unavailable", unsupported_browser: "This browser cannot start secure voice", network_unavailable: "Network unavailable", audio_blocked: "Audio playback blocked", session_expired: "Voice session expired", hermes_unavailable: "Hermes is unavailable" };
export function voiceFailure(error: unknown): VoiceFailureCategory { const name = error instanceof DOMException ? error.name : ""; const message = error instanceof Error ? error.message.toLowerCase() : ""; if (name === "NotAllowedError" || /permission|denied/.test(message)) return "permission_denied"; if (/expired|401/.test(message)) return "session_expired"; if (/audio|playback|notallowederror/.test(message)) return "audio_blocked"; if (/provider|not configured/.test(message)) return "provider_unavailable"; if (/hermes|chat/.test(message)) return "hermes_unavailable"; if (/network|fetch|offline/.test(message)) return "network_unavailable"; return "realtime_unavailable"; }
export function safeVoiceTraceEvent(value: unknown): string | null { const allowed = new Set(["voice_session_started", "microphone_ready", "transcript_received", "hermes_message_created", "council_started", "response_ready", "audio_response_started", "audio_response_completed", "voice_session_ended", "voice_error"]); const event = String(value ?? ""); return allowed.has(event) ? event : null; }
