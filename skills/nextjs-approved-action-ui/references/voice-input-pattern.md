# VoiceInput Presentational Component Pattern

File: `src/app/<page>/VoiceInput.tsx`

## Prop Shape

```ts
export interface VoiceInputProps {
  onSubmit: (text: string) => Promise<void>;
  busy: boolean;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}
```

## State Machine

```
idle → listening → transcript_ready → needs_approval → executing → completed
                                                       ↘ failed
                                                    idle (reset/cancel)
```

- `needs_approval` replaces intermediate `transcript_ready` when `preview.risk !== 'read'`
- Show "Approve and run" only when `requiresApproval(state, preview)` is true
- Show "Send" for read-only previews

## Browser SpeechRecognition Typings (local only)

```ts
interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}
interface BrowserSpeechRecognitionErrorEvent { error: string; }
interface BrowserSpeechRecognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
interface BrowserSpeechRecognitionConstructor { new (): BrowserSpeechRecognition; }
```

## Mount-time Setup

```ts
useEffect(() => {
  if (!isSpeechRecognitionAvailable()) {
    handleError('Voice unavailable — type your request instead.');
    return;
  }
  const win = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!Ctor) { handleError('Speech API unavailable'); return; }
  const recognition = new Ctor();
  // configure listeners...
}, [isBrowserSupported, updateStatus, handleError]);
```

## Cleanup Rules

- `useEffect` cleanup calls `recognition.abort()`
- `reset()` aborts then zeros `editable`, `transcript`, `interim`, `preview`, `status`
- `onend` handler returns to `idle` only if still listening

## UI Rules

- mic button is push-to-talk only; no auto-start
- editable `<textarea>` appears after `transcript_ready` or `needs_approval`
- show intent preview + risk badge when `preview` exists
- "Reset" button clears everything
- `disabled`/`busy` blocks all actions
