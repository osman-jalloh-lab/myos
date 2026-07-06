import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VoiceState,
  riskLevel,
  intentPreview,
  isExecutableState,
  canAutoReply,
  requiresApproval,
  isSpeechRecognitionAvailable,
  speak,
  stopSpeaking,
  createVoiceController,
} from "@/lib/voice";

describe("voice state/rules", () => {
  it("returns correct state predicates", () => {
    expect(isExecutableState("transcript_ready" as VoiceState)).toBe(true);
    expect(isExecutableState("idle" as VoiceState)).toBe(false);
    const preview = intentPreview("update my project");
    expect(requiresApproval("needs_approval" as VoiceState, preview)).toBe(true);
    expect(canAutoReply("needs_approval" as VoiceState, preview)).toBe(false);
    const readPreview = intentPreview("what is today's status");
    expect(canAutoReply("transcript_ready" as VoiceState, readPreview)).toBe(true);
    expect(requiresApproval("transcript_ready" as VoiceState, readPreview)).toBe(false);
  });

  it("risk-level detection covers risky/write actions", () => {
    expect(riskLevel("deploy to production")).toBe("write");
    expect(riskLevel("send email to the team")).toBe("write");
    expect(riskLevel("create calendar event")).toBe("write");
    expect(riskLevel("show me today's status")).toBe("read");
  });
});

describe("speech availability", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = {} as unknown as Window;
    delete (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (globalThis.window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    delete (globalThis.window as unknown as Record<string, unknown>).speechSynthesis;
  });

  it("returns false when no recognition API", () => {
    expect(isSpeechRecognitionAvailable()).toBe(false);
  });

  it("speak/stopSpeaking are safe no-ops when unavailable", () => {
    expect(() => {
      speak("hello", true);
      speak("hello", false);
      stopSpeaking();
    }).not.toThrow();
  });
});

describe("createVoiceController", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = {} as unknown as Window;
    delete (globalThis.window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (globalThis.window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });

  it("returns null when recognition is unavailable", () => {
    expect(createVoiceController(() => {})).toBeNull();
  });
});
