# Hardened Hermes Restricted Process Runner

The audited Hermes executable exposes `chat` and `--oneshot`; neither is a verified no-tools, no-delegation planning mode. The latter explicitly executes a workspace packet. Therefore the hardened runner is intentionally unavailable and never spawns Hermes. This preserves the provider interface and reduced-environment/redaction helpers while preventing unsafe invocation.

No fixed safe command or arguments can be documented yet. A future runner requires Hermes vendor evidence for a non-interactive no-tools mode, then tests for output caps, timeout/abort, and Windows process-tree termination before enabling it.
