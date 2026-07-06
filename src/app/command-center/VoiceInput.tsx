'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { VoiceIntentPreview } from '@/lib/voice';
import { intentPreview, requiresApproval, isSpeechRecognitionAvailable } from '@/lib/voice';

// --- Browser SpeechRecognition typings used by this component only ---
interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{
    0: { transcript: string };
    isFinal: boolean;
  }>;
}
interface BrowserSpeechRecognitionErrorEvent {
  error: string;
}
interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognition;
}

// ---- Types ----
export interface VoiceInputProps {
  onSubmit: (text: string) => Promise<void>;
  busy: boolean;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}

export interface VoiceInputState {
  status: 'idle' | 'listening' | 'processing' | 'transcript_ready' | 'needs_approval' | 'executing' | 'completed' | 'failed' | 'unsupported';
  transcript: string;
  editable: string;
  interim: string;
  preview: VoiceIntentPreview | null;
}

// ---- Component ----
export function VoiceInput({ onSubmit, busy, onTranscript, onError, disabled = false }: VoiceInputProps) {
  const [state, setState] = useState<VoiceInputState>({
    status: 'idle',
    transcript: '',
    editable: '',
    interim: '',
    preview: null,
  });

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        recognitionRef.current?.abort();
        recognitionRef.current = null;
      } catch {
        // ignore cleanup errors
      }
    };
  }, []);

  // Stable callback wrappers (avoid stale closures)
  const updateStatus = useCallback((status: VoiceInputState['status']) => {
    if (mountedRef.current) {
      setState(prev => ({ ...prev, status }));
    }
  }, []);

  const handleFinalTranscript = useCallback((final: string, interimText: string) => {
    const preview = intentPreview(final);
    if (mountedRef.current) {
      setState(prev => ({
        ...prev,
        transcript: final,
        editable: final,
        interim: interimText,
        preview,
        status: 'transcript_ready',
      }));
    }
    onTranscript?.(final);
  }, [onTranscript]);

  const handleError = useCallback((message: string) => {
    if (mountedRef.current) {
      setState(prev => ({ ...prev, status: 'failed' }));
    }
    onError?.(message);
  }, [onError]);

  // ---- Speech recognition ----
  useEffect(() => {
    if (!isSpeechRecognitionAvailable()) {
      handleError('Voice unavailable — type your request instead.');
      return;
    }

    const win = window as Window & { SpeechRecognition?: BrowserSpeechRecognitionConstructor; webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor };
    const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!Ctor) { handleError("Speech API unavailable"); return; }
    const recognition = new Ctor();
    recognitionRef.current = recognition;

    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      updateStatus('listening');
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript || interimTranscript) {
        handleFinalTranscript(finalTranscript || interimTranscript, interimTranscript);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        handleError('No speech detected. Please try again.');
      } else if (event.error === 'audio-capture') {
        handleError('Microphone not available. Please check permissions.');
      } else if (event.error !== 'aborted') {
        handleError(`Voice error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      if (mountedRef.current) {
        setState(prev => {
          if (prev.status === 'listening') {
            return { ...prev, status: 'idle' };
          }
          return prev;
        });
      }
    };

    return () => {
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    };
    // We intentionally exclude onTranscript/onError from deps by using stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeechRecognitionAvailable, updateStatus, handleError]);

  // ---- Actions ----
  const startListening = useCallback(() => {
    if (!recognitionRef.current || state.status === 'listening' || busy || disabled) {
      return;
    }

    try {
      // Reset state for new listening session
      setState(prev => ({ ...prev, interim: '', transcript: '', editable: '' }));
      recognitionRef.current.start();
    } catch (error) {
      // If already started, this is a no-op or benign error
      if (error instanceof Error) {
        console.warn(error.message);
      } else {
        console.warn('Speech recognition start failed');
      }
    }
  }, [state.status, busy, disabled]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current && state.status === 'listening') {
      try {
        recognitionRef.current.abort();
      } catch {
        // ignore
      }
    }
  }, [state.status]);

  const reset = useCallback(() => {
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }
    setState({
      status: 'idle',
      transcript: '',
      editable: '',
      interim: '',
      preview: null,
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = state.editable.trim();
    if (!text || busy) return;

    const preview = state.preview || intentPreview(text);

    if (requiresApproval(state.status, preview)) {
      // Use caller-provided onSubmit which should handle approval flow
      await onSubmit(text);
      return;
    }

    // No approval needed — execute directly
    await onSubmit(text);
  }, [state.editable, state.preview, state.status, busy, onSubmit]);

  const handleVoiceSubmit = useCallback(async () => {
    const text = state.editable.trim();

    // Update transcript for parent
    if (text) {
      onTranscript?.(text);
    }

    // Business logic handled by parent via onSubmit prop
    await onSubmit(text);
  }, [state.editable, onSubmit, onTranscript]);

  // ---- Derived UI state ----
  const isListening = state.status === 'listening';
  const isProcessing = state.status === 'processing';
  const isReady = state.status === 'transcript_ready' || state.status === 'needs_approval';
  const isUnsupported = state.status === 'unsupported';
  const needsApproval = state.status === 'needs_approval' || (state.preview ? requiresApproval(state.status, state.preview) : false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Mic button — push-to-talk only, starts on click */}
        <button
          type="button"
          onClick={isListening ? stopListening : startListening}
          disabled={busy || isUnsupported || isProcessing}
          aria-label={isListening ? 'Stop listening' : 'Start voice input'}
          title={isUnsupported ? 'Voice unavailable' : isListening ? 'Click to stop' : 'Click to speak'}
          style={{
            padding: '8px 16px',
            borderRadius: 10,
            border: `1px solid ${isListening ? '#34D399' : '#94A3B8'}55`,
            background: isListening ? 'rgba(52,211,153,0.15)' : 'rgba(148,163,184,0.08)',
            color: isListening ? '#34D399' : '#e6e8ee',
            fontSize: 12,
            fontWeight: 700,
            cursor: busy || isUnsupported ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            opacity: busy || isUnsupported ? 0.6 : 1,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: isListening ? '#34D399' : '#94A3B8',
              boxShadow: isListening ? '0 0 12px #34D39988' : 'none',
            }}
          />
          {isListening ? 'Listening...' : isUnsupported ? 'Voice unavailable' : 'Push to talk'}
        </button>

        {/* Status label */}
        <span
          aria-live="polite"
          style={{
            color: '#94A3B8',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {state.status.replace(/_/g, ' ')}
        </span>

        {/* Reset button */}
        {(state.status !== 'idle') && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            aria-label="Reset voice input"
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid rgba(239,68,68,0.35)',
              background: 'rgba(239,68,68,0.08)',
              color: '#F87171',
              fontSize: 12,
              fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Reset
          </button>
        )}
      </div>

      {/* Transcript area — shown when we have content or are ready */}
      {(state.transcript || state.editable || isReady) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            htmlFor="voice-transcript"
            style={{ color: '#94A3B8', fontSize: 12, fontWeight: 700 }}
          >
            I heard:
          </label>
          <textarea
            id="voice-transcript"
            value={state.editable}
            onChange={(e) => setState(prev => ({ ...prev, editable: e.target.value }))}
            rows={3}
            disabled={busy}
            aria-label="Transcript — edit before sending"
            placeholder="Your transcript will appear here..."
            style={{
              width: '100%',
              background: 'rgba(8,13,24,0.62)',
              border: '1px solid #28324A',
              borderRadius: 10,
              padding: '9px 12px',
              color: '#F1F4FB',
              fontSize: 12,
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
              opacity: busy ? 0.7 : 1,
            }}
          />

          {/* Intent preview + risk badge */}
          {(state.preview || needsApproval) && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <span style={{ color: '#94A3B8', fontSize: 11, fontWeight: 700 }}>
                Planned action:
              </span>
              <span style={{ color: '#D8DEEB', fontSize: 12 }}>
                {state.preview?.summary || intentPreview(state.editable).summary}
              </span>
              <span
                style={{
                  padding: '2px 9px',
                  borderRadius: 999,
                  border: '1px solid #28324A',
                  color: state.preview?.risk === 'read' ? '#34D399' : '#FBBF24',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {state.preview?.risk === 'read' ? 'Read-only' : 'Needs approval'}
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            {needsApproval ? (
              <button
                type="button"
                onClick={handleVoiceSubmit}
                disabled={busy}
                aria-label="Approve and run"
                style={{
                  padding: '8px 14px',
                  borderRadius: 10,
                  background: 'rgba(52,211,153,0.15)',
                  border: '1px solid rgba(52,211,153,0.38)',
                  color: '#34D399',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Approve and run
              </button>
            ) : (
              <button
                type="button"
                onClick={handleVoiceSubmit}
                disabled={busy}
                aria-label="Send command"
                style={{
                  padding: '8px 14px',
                  borderRadius: 10,
                  background: 'rgba(96,165,250,0.15)',
                  border: '1px solid rgba(96,165,250,0.35)',
                  color: '#60A5FA',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const VoiceInputComponent = VoiceInput;
export default VoiceInput;
