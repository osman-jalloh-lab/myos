# Voice Command Center Session Notes

- Browser-only voice module: `src/lib/voice.ts`
- API routes: `src/app/api/voice/transcript/route.ts`, `src/app/api/voice/execute/route.ts`
- UI components: `VoiceInput.tsx`, `VoiceChatPanel.tsx`, extracted `ChatPanel.tsx`
- Common pitfall: Vitest `ReferenceError: window is not defined` for browser APIs; stub `globalThis.window` in tests.
- Chat response shape: `{ reply: { content?: string } }`; always guard `reply.content` before appending assistant messages.
