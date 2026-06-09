# Hermes Execution Layer

Additive execution capability on top of the existing Hermes OS chat system. When activated, Hermes can plan, tool-call, and return real results for action commands — not just text responses.

## Activation

Set `HERMES_EXECUTION_ENABLED=true` in `.env.local` (and in Vercel env vars for production).

Without this flag, every chat message flows through the existing `routeMessage()` path unchanged. The execution layer is completely dormant.

## Architecture

```
User message (POST /api/chat)
        │
        ▼
shouldUseExecutionLayer()   ← checks flag + regex patterns
        │
  ┌─────┴─────────────────────────────────┐
  │ yes                                   │ no
  ▼                                       ▼
/api/hermes/execute              existing routeMessage() path
        │
        ▼
  plan(request)          ← rule-based intent detection, no LLM
        │
        ▼
  execute(plan, request) ← step-by-step tool runner, approval gate
        │
        ▼
  ExecutionResponse      ← { status, answer, toolCalls, artifacts }
```

The execute route (`/api/hermes/execute`) is also callable directly — useful for testing without going through the chat interface.

## Files

```
src/lib/hermes-execution/
  types.ts                     — all shared TypeScript interfaces
  tool-registry.ts             — in-memory tool store, lazy init
  mcp-adapter.ts               — graceful no-op (no MCP wired yet)
  planner.ts                   — rule-based intent → ExecutionPlan
  executor.ts                  — runs plan steps, collects results
  detect-execution-request.ts  — isExecutionRequest() + feature flag guard
  tools/
    internal-tools.ts          — 9 registered tools (see below)

src/app/api/hermes/execute/route.ts   — POST /api/hermes/execute
src/app/api/chat/route.ts             — additive execution path (feature-flagged)
```

## Registered tools

| Tool name | What it does | Risk level |
|---|---|---|
| `internal.chat.respond` | Fallback — lists available commands | read |
| `internal.github.inspectRepo` | Fetches GitHub repo metadata + README | read |
| `internal.tasks.create` | Creates a task via existing `lib/tasks.ts` | internal_write |
| `internal.resume.generate` | Generates resume draft via `callModel()` | internal_write |
| `internal.email.search` | Fetches inbox via existing `lib/gmail.ts` OAuth | read |
| `internal.email.classifyImportant` | Keyword-classifies fetched emails for action items | read |
| `internal.email.placeholderSearch` | Fallback if email not connected | read |
| `internal.email.createDraft` | Queues email draft into approval system | external_write |
| `internal.approval.create` | Queues any action into approval system | internal_write |

## Risk model

| Risk | Behavior |
|---|---|
| `read` | Runs automatically |
| `internal_write` | Runs automatically (writes to own DB only) |
| `external_write` | Runs the tool (which queues approval), returns `approval_required` status |
| `dangerous` | Never runs — always blocked |

Permanently blocked tools (can never be registered or executed): `internal.email.send`, `internal.email.deleteThread`, `internal.file.delete`, `internal.job.applyNow`, `internal.payment.execute`.

## Intents the planner detects

| Intent | Trigger phrase examples | Tools |
|---|---|---|
| `github_repo_review` | "inspect https://github.com/owner/repo", "what is this repo" | `internal.github.inspectRepo` |
| `email_triage` | "check my email", "what's in my inbox", "any recruiter emails" | `internal.email.search` → `internal.email.classifyImportant` |
| `email_draft` | "draft a reply", "write an email to", "compose an email" | `internal.email.createDraft` (requires approval) |
| `task_create` | "create a task to...", "remind me to...", "todo: ..." | `internal.tasks.create` |
| `resume_builder` | "build me a resume for [role]", "tailor my resume" | `internal.resume.generate` |
| `chat` | anything else | `internal.chat.respond` |

## Manual test commands

After setting `HERMES_EXECUTION_ENABLED=true` and starting `npm run dev`:

**Test 1 — GitHub repo inspection (read, no auth required)**
```
POST /api/hermes/execute
{ "message": "inspect https://github.com/vercel/next.js", "source": "chat" }
```
Expected: `status: "completed"`, answer includes repo name, language, stars.

**Test 2 — Task creation**
```
POST /api/hermes/execute
{ "message": "create a task to follow up with the recruiter at Leidos tomorrow", "source": "chat" }
```
Expected: `status: "completed"`, answer confirms task title and due date, artifact type `task`.

**Test 3 — Email triage (requires Google account linked)**
```
POST /api/hermes/execute
{ "message": "check my email for job follow-ups", "source": "chat" }
```
Expected: `status: "completed"`, answer lists emails needing action. If not linked: graceful error message from `internal.email.search`.

**Test 4 — Email draft (approval gate)**
```
POST /api/hermes/execute
{ "message": "draft a reply to the Leidos recruiter", "source": "chat" }
```
Expected: `status: "approval_required"`, answer says queued for approval, artifact type `email_draft`.

**Test 5 — Chat fallback**
```
POST /api/hermes/execute
{ "message": "what is the weather today", "source": "chat" }
```
Expected: `status: "completed"`, answer lists supported commands (fallback tool).

**Test 6 — Feature flag off**
```
# Without HERMES_EXECUTION_ENABLED=true:
POST /api/hermes/execute { "message": "inspect https://github.com/..." }
```
Expected: `503 { "error": "Execution layer is not enabled..." }`.

## What is NOT yet connected

- No MCP tools are wired (the `mcp-adapter.ts` is a graceful no-op). When Hermes OS gets an MCP server registered, the registry's `hasTool("mcp.*")` check in the planner will automatically route to it over internal tools.
- `GITHUB_TOKEN` env var is optional but recommended — without it, GitHub API is rate-limited to 60 requests/hour per IP.
- Ollama tool (`internal.ollama.generate`) is not yet registered — add to `internal-tools.ts` when `OLLAMA_BASE_URL` is configured.
- Calendar and finance execution tools are not yet registered — Kairos and Plutus have their own agent read tools but aren't wired into the execution registry yet.

## Adding a new tool

```typescript
// In src/lib/hermes-execution/tools/internal-tools.ts, inside registerInternalTools():
registerTool({
  name: "internal.myDomain.myAction",
  description: "One sentence describing what this does.",
  risk: "read",          // read | internal_write | external_write
  requiresApproval: false,
  execute: async (input, ctx) => {
    // input: Record<string, unknown> — validated in execute()
    // ctx: { userId, source, previousResults, env }
    return {
      answer: "Human-readable result string for the chat reply.",
      artifacts: [],     // optional ExecutionArtifact[]
    };
  },
});
```

Then add a pattern for it in `detect-execution-request.ts` and a plan branch in `planner.ts`.
