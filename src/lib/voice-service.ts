import { createExecutionRun, appendExecutionEvent, getExecutionRun } from "@/lib/execution-runs";
import { safeVoiceTraceEvent } from "@/lib/voice-realtime";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-mini";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
function key(): string { const value = process.env.OPENAI_API_KEY?.trim(); if (!value) throw new Error("Voice provider is not configured."); return value; }
export async function createVoiceSession(userId: string): Promise<{ clientSecret: string; expiresAt: number | null; model: string; runId: string }> {
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" }, body: JSON.stringify({ session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, noise_reduction: { type: "near_field" }, transcription: { model: TRANSCRIBE_MODEL, language: "en" }, turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 650 } } } } }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Voice provider is unavailable.");
  const payload = await response.json() as { value?: string; client_secret?: { value?: string; expires_at?: number }; expires_at?: number }; const clientSecret = payload.value ?? payload.client_secret?.value; if (!clientSecret) throw new Error("Voice provider returned no temporary authorization.");
  const run = await createExecutionRun({ userId, executor: "internal", currentPhase: "initializing", currentActivity: "Hermes voice session started." });
  await appendExecutionEvent(run.id, { phase: "initializing", source: "web", message: "voice_session_started", safeDetails: { transport: "openai_realtime_webrtc", mode: "transcription_only" } });
  return { clientSecret, expiresAt: payload.expires_at ?? payload.client_secret?.expires_at ?? null, model: REALTIME_MODEL, runId: run.id };
}
export async function synthesizeHermesSpeech(text: string): Promise<ArrayBuffer> { const clean = text.replace(/<[^>]*>/g, " ").replace(/[#*_`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 3_500); if (!clean) throw new Error("Hermes returned no speakable response."); const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: TTS_MODEL, voice: "cedar", input: clean, format: "mp3" }), signal: AbortSignal.timeout(25_000) }); if (!response.ok) throw new Error("Voice audio provider is unavailable."); return response.arrayBuffer(); }
const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL?.trim() || "whisper-1";

/**
 * Transcribes a bounded, already-downloaded audio buffer (e.g. a Telegram
 * voice message) via OpenAI's file transcription endpoint. This is a separate
 * path from the Realtime WebRTC session above — Telegram voice notes arrive
 * as a static file, not a live stream, so there is no session to reuse.
 */
export async function transcribeAudioBuffer(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  const extension = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : mimeType.includes("webm") ? "webm" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extension}`);
  form.append("model", WHISPER_MODEL);
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Transcription provider is unavailable.");
  const payload = await response.json() as { text?: string };
  const text = payload.text?.trim();
  if (!text) throw new Error("Transcription returned no text.");
  return text;
}

export async function traceVoiceEvent(userId: string, runId: string, rawEvent: unknown, details?: Record<string, unknown>): Promise<void> { const event = safeVoiceTraceEvent(rawEvent); if (!event) throw new Error("Unsupported voice trace event."); const run = await getExecutionRun(userId, runId); if (!run) throw new Error("Voice session not found."); const terminal = event === "voice_session_ended"; await appendExecutionEvent(runId, { phase: terminal ? "completed" : event === "voice_error" ? "failed" : event === "transcript_received" || event === "hermes_message_created" ? "planning" : "initializing", source: "web", severity: event === "voice_error" ? "error" : "info", message: event, safeDetails: details ? { category: details.category, transport: details.transport } : undefined, status: terminal ? "completed" : event === "voice_error" ? "failed" : "running", meaningful: true }); }
