---
name: nextjs-voice-feature-branches
description: "Next.js feature-branch voice UI implementation: browser-only speech, clean extraction from large Command Center pages, chat API shape, and common Turbopack/TypeScript pitfalls."
---

platforms: []
version: 0.1.0
license: MIT
# Next.js Feature Branch: Voice Command UI

## Trigger
Use when adding a new client feature to a Next.js app route in an existing monorepo-style dashboard, especially when the main page component is large and you need a separate wrapper around an inner panel/chat UI.

## Objective
Add a voice-command UI to an existing dashboard without changing executor behavior, keeping raw audio out of backend executor paths, and maintaining a clean build with `prisma generate && next build`.

## Non-goals
- Do not touch any backend executor path to receive raw audio.
- Do not add Google sign-in, OAuth, or additional provider configs in this feature branch.
- Do not merge or deploy unless user explicitly approves merge/deploy later.

## Workflow
1. Branch hygiene: fetch `origin main`, create `feat/...`, do not modify PR #6 or its protected branch.
2. Inspect existing chat/command UI first (`src/app/command-center/CommandCenterClient.tsx`), especially existing `/api/chat` request/response handling and its `reply.content` shape.
3. Reuse existing submission, queue, approval, intent, and routing logic instead of duplicating it.
4. Browser-only voice APIs:
   - `VoiceInput.tsx`: push-to-talk control, interim/final transcript separation, editable transcript box, plain-language intent preview, approval gate for risky/write actions, fallback text input when unsupported.
   - `src/lib/voice.ts`: pure module for risk classification, intent preview formatting, state definitions.
   - `/api/voice/transcript`: auth-gated optional transcription gateway if needed later.
   - `/api/voice/execute`: auth-gated, routes approved voice text through the existing task/queue flow.
5. Cleanup rules:
   - Request microphone permission only on explicit user action.
   - Stop microphone tracks immediately when listening ends.
   - Never retain raw audio.
   - No wake word, no continuous listening, no background microphone access in V1.
6. Privacy/safety:
   - Do not execute from interim speech results.
   - Do not auto-submit builds, deployments, email, calendar events, or file changes without confirmation.
   - Show "I heard: …", "Planned action: …", and explicit "Approve and run" for risky/write actions.
7. Optional UX:
   - Toggle for browser speech synthesis (muted by default).
   - Show execution state: idle, listening, processing, transcript_ready, needs_approval, executing, completed, failed.

## Verification
- Unit tests: `npm run test -- --run src/lib/__tests__/voice.test.ts`
- Lint: `npm run lint`, confirm zero errors.
- Build: `npm run build` and confirm no TS/build failures before declaring success. Include `prisma generate` in the build.

## PR deliveries
- Separate PR with screenshots and a brief demo runbook.
- Do not merge or deploy unless user explicitly approves merge/deploy later.

## Implementation pattern
### Large page extraction
When pulling an inner panel out of a large `CommandCenterClient.tsx`:
- Extract matching props/types.
- Preserve exact JSX/styles.
- Replace the inline component usage with the new imported component and remove the old local definition entirely.

### Default vs named exports after extraction
`Next.js build` may emit: `Module './ChatPanel' has no exported member 'ChatPanel'. Did you mean 'import ChatPanel from "./ChatPanel"' instead?`
Cause: you created a default export but imported as a named export.
Fix: match import style to actual export shape.

### Turbopack `next.config.js` warning: `path.join(...)` / `fs.readFileSync`
This is often a noise warning from existing runtime-read folders and does not block `next build` if TypeScript passes. Do not rewrite config unless user asks.
Do not claim the build failed from Turbopack warnings if the actual error is TypeScript or import resolution.

### Build failure classification
If `npm run build` fails:
- Read the actual Tail of the Turbopack/TypeScript error.
- Repair only the actual failing file/line.
- Rerun build once after the repair; if it still fails, read again.

### External `auth()` in `lib/auth.ts`
VS Code TS server may report `Cannot find module '@/lib/auth'` unless its config includes `baseUrl: src`.
Fix: ignore the editor-only false positive or align workspace TS baseUrl to match Next.js project settings. Do not change runtime `@/lib/auth` imports to relative paths to avoid breaking Vercel.

### Vitest + browser globals
If tests fail with `ReferenceError: window is not defined`, stub `globalThis.window` before importing/testing browser-only code.

## Minimal invasive change principle
Add a thin wrapper `VoiceChatPanel` that uses `ChatPanel` via React composition and sends text through `/api/chat` for read-only questions and `/api/voice/execute` for non-read tasks. No changes to `CommandCenterClient.tsx` beyond swapping the chat tab wrapper.

## File references
- Created: `src/lib/voice.ts`
- Created: `src/app/api/voice/transcript/route.ts`
- Created: `src/app/api/voice/execute/route.ts`
- Created/extracted: `src/app/command-center/ChatPanel.tsx`
- Created: `src/app/command-center/VoiceInput.tsx`
- Created: `src/app/command-center/VoiceChatPanel.tsx`
- Patched: `src/app/command-center/CommandCenterClient.tsx`

See `references/voice-command-center-session.md` for the exact `window is not defined` reproduction and `/api/chat` JSON response shape observed in this session.
