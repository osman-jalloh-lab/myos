export const HERMES_VOICE_STATES = ["idle", "listening", "thinking", "council", "executing", "speaking", "muted", "error"] as const;
export type HermesVoiceState = typeof HERMES_VOICE_STATES[number];

export const HERMES_VOICE_CHAT_ENDPOINT = "/api/chat" as const;

export function voiceStateAfterActivity(input: { active: boolean; muted: boolean; busy: boolean; speaking: boolean; failed?: boolean }): HermesVoiceState {
  if (input.failed) return "error";
  if (!input.active) return "idle";
  if (input.muted) return "muted";
  if (input.speaking) return "speaking";
  if (input.busy) return "thinking";
  return "listening";
}
