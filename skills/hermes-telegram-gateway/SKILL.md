---
name: hermes-telegram-gateway
description: "Bring up and verify Telegram as a messaging gateway for Hermes Agent on Windows, including verification and read-back checks."
version: 0.1.0
---

platforms: []
license: MIT
# Hermes Telegram Gateway (Windows)

Use this when the goal is to enable Telegram and confirm the bot gateway is actually live on a Windows host.

## Non-negotiables
- Preserve existing bot token; never expose it in logs or chat.
- Verify state with `hermes gateway status`, then read-back logs if available.
- Stop if `gateway status` shows no running gateway process after install.

## Windows-specific pattern
Interactive `hermes gateway install` asks about auto-start and can need UAC for
the Scheduled Task branch. Two answers keep this deterministic:

- First prompt: start now. `y`
- Second prompt: auto-start. `n`

Wired command:
```bash
printf 'y\nn\n' | hermes gateway install
```

Read gateways as live only when status reports both:
- Scheduled Task registered with `Status: Ready`
- `Gateway process running (PID: ...)`

If the second prompt asks about UAC, choose the non-admin path. A direct-spawn
from install is enough; the task is to operate the bot, not to register a
Windows-service copy.

## Verification
1. Run `hermes gateway status`.
2. Inspect `~/.hermes/logs/gateway.log` if present.
3. From a terminal, treat the gateway as live only when a running process is shown.

## Minimal result to broadcast
Once verified successfully, return:
- Files configured
- Gateway PID
- Platform status

## References
- See `references/windows-gateway-setup.md` for concrete notes from this host.