"use client";

export type VoiceState =
  | "idle"
  | "listening"
  | "processing"
  | "transcript_ready"
  | "needs_approval"
  | "executing"
  | "completed"
  | "failed"
  | "unsupported";

export interface VoiceIntentPreview {
  action: string;
  risk: "read" | "write" | "external";
  summary: string;
}

export interface VoiceResult {
  taskId?: string;
  status?: VoiceState;
  message?: string;
  previewUrl?: string;
}

const HIGH_RISK_RE = /\b(build|deploy|send|email|calendar|event|meeting|delete|remove|update|change|write|save|publish|post)\b/i;

export function riskLevel(text: string): VoiceIntentPreview["risk"] {
  if (HIGH_RISK_RE.test(text)) return "write";
  return "read";
}

export function intentPreview(text: string): VoiceIntentPreview {
  return {
    action: text.trim(),
    risk: riskLevel(text),
    summary: text.trim() || "No transcript yet",
  };
}

export function isExecutableState(state: VoiceState): boolean {
  return state === "transcript_ready" || state === "needs_approval";
}

export function canAutoReply(state: VoiceState, preview: VoiceIntentPreview): boolean {
  return state === "transcript_ready" && preview.risk === "read";
}

export function requiresApproval(state: VoiceState, preview: VoiceIntentPreview): boolean {
  return isExecutableState(state) && preview.risk !== "read";
}

interface RecognitionApi {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: (event: { results: unknown; resultIndex: number }) => void;
  onerror: (event: { error: string }) => void;
  onend: () => void;
  onstart: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export function isSpeechRecognitionAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as Window & { SpeechRecognition?: new () => RecognitionApi; webkitSpeechRecognition?: new () => RecognitionApi };
  return typeof win.SpeechRecognition === "function" || typeof win.webkitSpeechRecognition === "function";
}

export function speak(text: string, muted: boolean): void {
  if (muted || !text) return;
  try {
    const S = window as { speechSynthesis?: { cancel: () => void; speak: (u: SpeechSynthesisUtterance) => void } };
    if (!S.speechSynthesis) return;
    S.speechSynthesis.cancel();
    S.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // output not critical
  }
}

export function stopSpeaking(): void {
  try {
    const S = window as { speechSynthesis?: { cancel: () => void } };
    S.speechSynthesis?.cancel();
  } catch {
    // ignore
  }
}

function createRecognition(): RecognitionApi | null {
  if (typeof window === "undefined") return null;
  const win = window as Window & { SpeechRecognition?: new () => RecognitionApi; webkitSpeechRecognition?: new () => RecognitionApi };
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (typeof Ctor !== "function") return null;

  const r = new Ctor();
  r.lang = "en-US";
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  return r;
}

function resultTranscript(alt: { transcript?: string }): string {
  return (alt.transcript ?? "").trim();
}

function resultIsFinal(alt: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = alt as any;
  return !!a.isFinal;
}

export interface VoiceController {
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  getState: () => VoiceState;
  getInterim: () => string;
}

export function createVoiceController(onResult: (final: string, interim: string) => void): VoiceController | null {
  if (!isSpeechRecognitionAvailable()) return null;

  let state: VoiceState = "idle";
  const listeners = new Set<(s: VoiceState) => void>();
  const setState = (next: VoiceState) => {
    state = next;
    listeners.forEach((fn) => fn(next));
  };

  let recognition: RecognitionApi | null = null;
  let interim = "";

  const buildRecognition = () => {
    if (recognition) {
      try { recognition.abort(); } catch { /* ignore */ }
    }
    recognition = createRecognition();
    if (!recognition) return;

    recognition.onstart = () => setState("listening");
    recognition.onend = () => {
      if (state === "listening") {
        setState("processing");
      }
    };
    recognition.onerror = () => {
      setState("failed");
    };
    recognition.onresult = (event: { results: unknown; resultIndex: number }) => {
      // Assume SpeechRecognitionResultList surface here; accessors read text safely.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultList = event.results as any;
      let latestFinal = "";
      let latestInterim = "";
      for (let i = event.resultIndex; i < resultList.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = resultList[i];
        for (let j = 0; j < result.length; j++) {
          const alt = result[j];
          const transcript = resultTranscript(alt);
          if (resultIsFinal(alt)) {
            latestFinal = transcript;
          } else {
            latestInterim = transcript;
          }
        }
      }
      interim = latestInterim;
      if (latestFinal) {
        onResult(latestFinal, latestInterim);
        setState("transcript_ready");
        try { recognition!.abort(); } catch { /* ignore */ }
      }
    };
  };

  return {
    start: async () => {
      if (state === "listening") return;
      interim = "";
      buildRecognition();
      if (!recognition) {
        setState("unsupported");
        return;
      }
      setState("listening");
      try {
        recognition.start();
      } catch {
        setState("failed");
      }
    },
    stop: () => {
      if (recognition) {
        try { recognition.abort(); } catch { /* ignore */ }
        recognition = null;
      }
      if (state === "listening" || state === "processing") {
        setState("failed");
      }
    },
    reset: () => {
      if (recognition) {
        try { recognition.abort(); } catch { /* ignore */ }
        recognition = null;
      }
      interim = "";
      setState("idle");
    },
    getState: () => state,
    getInterim: () => interim,
  };
}
