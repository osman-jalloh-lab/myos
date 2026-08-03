# Read-Only My OS Chat Planning Adapter Evidence

Starting commit: `c969785`.

Added `POST /api/orchestration/plan` and deterministic chat-planning modules. The adapter supports answer, research, plan, write, code, and review previews. Defaults are Hermes for answers, Claude for research/planning/writing/review, Codex for code, and optional DeepSeek review only.

It authenticates through My OS, derives the user from the session, uses a read-only skill registry view, validates with the existing orchestration policy, and returns `executionStatus: not_started`. It does not call providers, execute skills/tools, queue work, create approvals, retrieve Obsidian, or write durable state. The next surface is an explicitly authorized provider-backed planner or Telegram/Hermes Agent intake adapter.
