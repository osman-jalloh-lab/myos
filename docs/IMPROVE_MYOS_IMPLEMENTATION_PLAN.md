# Improve MyOS Implementation Plan
Branch: `feat/voice-command-center`

## Existing systems reused
- `src/lib/approvals.ts` — approval creation, approval state machine, audit logging.
- `src/lib/execution-queue.ts` — task creation/status updates/logs.
- `src/lib/build-intake.ts` — build intent parsing and project context.
- `src/lib/voice.ts` — voice controller, transcript/intent preview, risk helpers.
- `src/app/command-center/VoiceInput.tsx` — presentational push-to-talk UI.
- `src/app/command-center/VoiceChatPanel.tsx` — typed + voice command surface.
- `src/app/command-center/ChatPanel.tsx` — existing chat UI.
- `src/app/api/chat/route.ts` — existing read/chat path.
- `src/lib/design-build-pipeline.ts` — execution profile definitions.

## Files expected to change
- `src/lib/improve.ts`
- `src/app/api/improve/plan/route.ts`
- `src/app/api/improve/approve/route.ts`
- `src/app/api/improve/execute/route.ts`
- `src/app/api/voice/transcript/route.ts`
- `src/app/api/voice/execute/route.ts`
- `src/app/command-center/VoiceChatPanel.tsx`
- `src/app/command-center/ImproveMyOS.tsx`
- `src/app/command-center/CommandCenterClient.tsx`
- `src/app/voice-preview/page.tsx`
- `src/lib/__tests__/improve.test.ts`

## New endpoints proposed
- `POST /api/improve/plan`
- `POST /api/improve/approve`
- `POST /api/improve/execute`
- `GET /voice-preview`

## Risk boundary design
- Server-side risk class only.
- Green/Yellow: show plan, require approval, create task after approval.
- Red: manual review only; no executable button.
- Read-only requests never create executor tasks.

## Approval model
- Plan has server-generated fingerprint and expiry.
- Approval is one-time, owned by user, bound to plan fingerprint.
- Reuse existing `approvals.ts` + `auditLog` pattern with new action types.

## Test plan
- Plan/approval/execute happy path.
- Missing/expired/reused/wrong-user/mismatch rejection cases.
- Voice UI tests for stop/dismiss/unmount cleanup and interim blocking.
- `/voice-preview` mode checks.

## Rollback plan
- Feature lives on `feat/voice-command-center` only.
- Revert merge commits on this branch; do not touch `main` or PR #6.
- No schema migration in V1 if possible; otherwise keep migrations unapplied until review.
