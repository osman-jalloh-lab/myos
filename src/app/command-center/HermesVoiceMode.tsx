"use client";

import { useEffect, useRef, useState } from "react";
import type { HermesVoiceState } from "@/lib/voice-mode";

type RecognitionResultLike = { isFinal: boolean; 0?: { transcript?: string } };
type RecognitionEventLike = { results: ArrayLike<RecognitionResultLike> };
type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function recognitionConstructor(): (new () => RecognitionLike) | null {
  const scoped = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return scoped.SpeechRecognition ?? scoped.webkitSpeechRecognition ?? null;
}

export default function HermesVoiceMode({ onMessage, latestReply, busy }: { onMessage: (message: string) => Promise<void>; latestReply: string | null; busy: boolean }) {
  const [state, setState] = useState<HermesVoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [muted, setMuted] = useState(false);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const activeRef = useRef(false);
  const lastSpokenRef = useRef<string | null>(null);

  useEffect(() => { setSupported(Boolean(recognitionConstructor() && window.speechSynthesis)); }, []);
  useEffect(() => { if (busy && activeRef.current) setState("thinking"); }, [busy]);
  useEffect(() => {
    if (!latestReply || muted || !activeRef.current || latestReply === lastSpokenRef.current || !window.speechSynthesis) return;
    lastSpokenRef.current = latestReply;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(latestReply.replace(/[#*_`]/g, " ").slice(0, 1800));
    utterance.onstart = () => setState("speaking");
    utterance.onend = () => { if (activeRef.current) setState("listening"); };
    utterance.onerror = () => setState("error");
    window.speechSynthesis.speak(utterance);
  }, [latestReply, muted]);

  const stop = () => {
    activeRef.current = false;
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
    setState("idle");
  };

  const start = async () => {
    const Recognition = recognitionConstructor();
    if (!Recognition) { setSupported(false); setState("error"); return; }
    // The browser permission prompt is triggered only by this explicit click.
    activeRef.current = true;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let live = "";
      let final = "";
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const value = result[0]?.transcript?.trim() ?? "";
        if (result.isFinal) final += `${value} `; else live += `${value} `;
      }
      setTranscript((final || live).trim());
      if (final.trim()) {
        setState("thinking");
        void onMessage(final.trim()).catch(() => setState("error"));
      }
    };
    recognition.onerror = () => setState("error");
    recognition.onend = () => {
      if (!activeRef.current || muted) return;
      try { recognition.start(); setState("listening"); } catch { setState("error"); }
    };
    recognitionRef.current = recognition;
    try { recognition.start(); setState("listening"); } catch { setState("error"); }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (next) { recognitionRef.current?.stop(); window.speechSynthesis?.cancel(); setState("muted"); }
    else if (activeRef.current) void start();
  };

  return <section className="hermes-voice" aria-label="Hermes continuous voice mode">
    <div><span>Voice Mode</span><strong>{supported ? state : "unavailable"}</strong><small>{transcript || (supported ? "Voice and text use the same Hermes conversation." : "This browser has no compatible speech API. Text remains available.")}</small></div>
    <div className="hermes-voice-actions">
      {!activeRef.current ? <button type="button" onClick={() => void start()} disabled={!supported}>Start voice</button> : <button type="button" onClick={stop}>Stop</button>}
      <button type="button" onClick={toggleMute} disabled={!activeRef.current} aria-pressed={muted}>{muted ? "Unmute" : "Mute"}</button>
    </div>
  </section>;
}
