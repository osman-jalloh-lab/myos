# Restricted Hermes Planning Provider Core

Starting commit: `49703cb`. Added provider-neutral deterministic and injected-runner Hermes planning contracts, restricted prompt construction, bounded JSON plan parsing, policy revalidation, and transparent deterministic fallback. No process, queue, approval, model, Telegram, Obsidian, memory, or filesystem-runtime module is imported. Real Hermes process execution remains disabled; the next task is the dedicated hardened runner with Windows process-tree termination.
