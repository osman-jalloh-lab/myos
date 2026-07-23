---
name: nextjs-approved-action-ui
description: >
  Next.js features that require server-side approval gates before execution:
  voice commands, chat actions, AI-generated build plans, or any user-initiated
  action that must be classified, approved, and then routed through an execution
  queue. Covers presentational component extraction, API route patterns, risk
  classification, approval flow, UI state machines, and build-error recovery.
  Use when the task says "approval required", "risk classification", "no raw
  audio/actions to executor", or when implementing voice/chat UI for an
  authenticated backend.
---

platforms: []
version: 0.1.0
license: MIT
# Next.js Approved Action UI

## Trigger

Build a frontend feature where:
- user input is text or voice
- the backend classifies risk before acting
- write/external actions require explicit approval
- approved work reuses an existing execution queue or task runner
- no raw payloads reach privileged backend services without user consent

## Required Architecture

1. **Shared service** (`src/lib/<feature>.ts`)
   - risk classification: `green` / `yellow` / `red`
   - `createPlan(...)` — returns plan with `id`, `risk`, `requiresApproval`, `executor`, `executionProfile`
   - `createApproval(planId)` — returns approval record
   - `approveAndConsume(planId, approvalId)` — verifies and transitions plan state
   - `createImproveTask(planId, approvalId)` — enqueues to execution queue

2. **API routes** under `/api/<feature>/*`
   - `POST /api/<feature>/plan` — `auth()` guard, then `createPlan`
   - `POST /api/<feature>/approve` — `auth()` guard, returns approval
   - `POST /api/<feature>/execute` — `auth()` guard, checks `requiresApproval`, consumes approval, creates task via execution queue

3. **Presentational voice component** (`src/app/<page>/VoiceInput.tsx`)
   - prop shape: `onSubmit(text)`, `busy`, `onTranscript?`, `onError?`, `disabled?`
   - state machine: `idle → listening → transcript_ready → needs_approval → executing → completed/failed`
   - no `any` types: define `BrowserSpeechRecognition` interfaces locally
   - guard against `Ctor` possibly being undefined before `new Ctor()`
   - cleanup on unmount; abort mic tracks immediately on stop/cancel
   - editable transcript area before any submit
   - show intent preview + risk badge when transcript exists
   - "Approve and run" button only when `requiresApproval` is true

4. **Panel/wrapper** (`VoiceChatPanel.tsx` or equivalent)
   - compose voice input + existing chat panel
   - default import is safest for Client Components; avoid extra curly braces

5. **Router behavior**
   - preserve old routes during integration
   - mount new feature via a dedicated page/component rather than replacing existing UI inline

## Build-Error Recovery Patterns

### Missing default exports
Error: `Export default doesn't exist in target module`
Fix: Inspect source file exports. If it has only named exports, either switch import to named form or add `export default Component;` at the bottom. Do not assume next.config or TSConfig is wrong.

### Type mismatches after extraction
If you extract `ChatPanel` into its own file, update:
- its props (default initialMessages to `[]`)
- the parent import (`import V2ChatPanel` or `import ChatPanel`)
- the JSX usage (`<V2ChatPanel initialMessages={...} />`)

### `npm run build` exit-code gotcha
When invoking `npm run build` via a background/process wrapper, an exit code of `0` can mean:
- the wrapper itself exited cleanly, OR
- the output was truncated to "... exit 0, 1 lines output" because the runner never captured the real failure.

Always read the actual build log file (`/tmp/hermes-build-*.log`) or re-run in foreground to see the true TypeScript error line.

### Cache thrash
If you edited a `.tsx` export but the build still reports the old missing export, clear both:
- `.next/`
- `node_modules/.cache/`

Then re-run build.

## Voice/Presentational Component Checklist

- [ ] `useRef<BrowserSpeechRecognition | null>(null)` (no `any`)
- [ ] `isSpeechRecognitionAvailable()` guard before constructing recognition
- [ ] `const win = window as Window & { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor }`
- [ ] `const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition; if (!Ctor) return;`
- [ ] `recognition.onresult` and `recognition.onerror` typed locally
- [ ] `recognition.abort()` on unmount and on reset/cancel
- [ ] `setState(prev => ({...prev, status}))` never mutates state directly
- [ ] `busy` and `disabled` block mic start
- [ ] editable `<textarea>` for transcript correction
- [ ] `requiresApproval` checked with local `intentPreview(text)` before submit
- [ ] "Approve and run" vs "Send" conditional on preview risk

## Approval Flow UI

- **Green**: auto-execute after plan creation, or simple submit without approval
- **Yellow**: user clicks "Approve and create task" → approval record created → "Execute approved plan" button
- **Red**: show "Manual review required" panel; execution is blocked; task creation must happen outside this flow

## Testability Without New Dependencies

If the repo lacks `@testing-library/react`:
- extract pure presentational components (`VoiceInput`, `ChatPanel`) with no parent-specific props
- unit-test the pure logic in `src/lib/__tests__/voice.test.ts` (state transitions, `requiresApproval`, `intentPreview`, `canAutoReply`)
- abandon component-level tests rather than add dependencies without approval

## Release Guardrails

- never merge to `main` or promote to production without explicit approval
- never modify OAuth/auth code in a feature branch unless specifically tasked
- approved commands must flow through existing execution queue only
- no raw audio/transcript payloads to executor services
- produce a final report with: files created, files changed, adapter/API shape, router behavior before vs after, lint/test/build results, next migration step

## References

- `references/voice-input-pattern.md` — canonical VoiceInput component shape and browser SpeechRecognition typing
- `references/build-error-playbook.md` — Next.js build error catalog and fixes derived from this branch
- `templates/approval-route.ts` — starter API route with auth + approval guard
- `templates/improve-service.ts` — starter shared service with plan/approve/execute/\_task shape
