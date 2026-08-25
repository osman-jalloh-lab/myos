import { describe, expect, it } from "vitest";
import { INITIAL_VOICE_MACHINE, reduceVoiceState, safeVoiceTraceEvent, voiceFailure } from "@/lib/voice-realtime";
describe("Hermes realtime voice state", () => {
  it("moves through listening, thinking, and speaking without a Web Speech dependency", () => { const connecting = reduceVoiceState(INITIAL_VOICE_MACHINE, { type: "CONNECT" }); const listening = reduceVoiceState(connecting, { type: "READY" }); const thinking = reduceVoiceState(listening, { type: "TRANSCRIPT" }); expect(reduceVoiceState(thinking, { type: "SPEAK" }).state).toBe("speaking"); });
  it("keeps mute and explicit failure categories authoritative", () => { expect(reduceVoiceState({ ...INITIAL_VOICE_MACHINE, active: true }, { type: "MUTE" })).toMatchObject({ state: "muted", muted: true }); expect(voiceFailure(new DOMException("denied", "NotAllowedError"))).toBe("permission_denied"); });
  it("accepts only the bounded voice trace vocabulary", () => { expect(safeVoiceTraceEvent("transcript_received")).toBe("transcript_received"); expect(safeVoiceTraceEvent("raw_audio_payload")).toBeNull(); });
});
