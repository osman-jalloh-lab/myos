# Telegram Hermes Planning Bridge Evidence

Existing Telegram ownership remains `POST /api/telegram/webhook`: secret header validation, owner allowlist, canonical user lookup, and `sendTelegramMessage` reply transport. This change adds an opt-in `/plan` branch in that gateway. It builds a deterministic orchestration preview keyed by update ID and returns a concise planning-only reply that always says execution has not started.

No webhook registration, token, provider, specialist, queue, approval, skill execution, Obsidian, memory, or file modification path is invoked by the planning branch. Normal Telegram text routing is unchanged.
