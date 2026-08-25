import { describe, expect, it } from "vitest";
import { HERMES_VOICE_CHAT_ENDPOINT, HERMES_VOICE_STATES, voiceStateAfterActivity } from "@/lib/voice-mode";

describe("Hermes continuous voice mode contract", () => {
  it("uses the normal Hermes chat endpoint and exposes required states", () => {
    expect(HERMES_VOICE_CHAT_ENDPOINT).toBe("/api/chat");
    expect(HERMES_VOICE_STATES).toEqual(expect.arrayContaining(["idle", "listening", "thinking", "council", "executing", "speaking", "muted", "error"]));
  });

  it("keeps mute and failure states authoritative", () => {
    expect(voiceStateAfterActivity({ active: true, muted: true, busy: true, speaking: true })).toBe("muted");
    expect(voiceStateAfterActivity({ active: true, muted: false, busy: false, speaking: false, failed: true })).toBe("error");
  });
});
