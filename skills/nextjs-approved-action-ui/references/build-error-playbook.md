# Build-Error Playbook

Errors encountered in approved-action UI work and their fixes.

## Export default doesn't exist in target module

**Cause:** importing `import X from "./X"` when `X.tsx` only has named exports.

**Fix:** either switch to `import { X } from "./X"` or add `export default X;` at the bottom.

**Gotcha:** Adding a default export that does not exist produces TS7307. Verify actual exports first.

## Ctor is possibly 'undefined'

**Cause:** `const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition; new Ctor()`.

**Fix:** guard with `if (!Ctor) { handleError('Speech API unavailable'); return; }`.

## ChatPanel props after extraction

**Cause:** parent calls `<ChatPanel />` but the extracted component requires `initialMessages`.

**Fix:** default the prop: `function ChatPanel({ initialMessages = [] }: { initialMessages?: ChatMessage[] } = {})`.

## npm run build exit 0 but build actually failed

**Cause:** process wrapper reported exit 0 while the real build failed.

**Fix:** read the actual log file, or re-run in foreground after `rm -rf .next node_modules/.cache`.

## Cache retains stale export graph

**Cause:** `.next/` or `node_modules/.cache` was not cleared after adding/removing an export.

**Fix:** clear both directories before rebuild.

## React hook missing dependency warning

**Cause:** callback array omits a prop it uses, e.g. `useCallback(..., [state.status, busy])` while also reading `disabled`.

**Fix:** include `disabled` in the dependency array, or derive the guard inline.

## TypeScript `any` in `VoiceInput.tsx`

**Cause:** browser SpeechRecognition event args were typed as `any`.

**Fix:** define local interfaces `BrowserSpeechRecognitionEvent` / `BrowserSpeechRecognitionErrorEvent` and use them explicitly. Do not use `(event: any)`.
