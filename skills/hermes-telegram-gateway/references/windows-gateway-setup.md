# Windows Telegram gateway notes

- `hermes gateway install` in this account prompted twice:
  - `Start the gateway now after install? [Y/n]:` -> `y`
  - `Start the gateway automatically on Windows login with a Scheduled Task? [Y/n]:` -> `y` can require UAC
- First auto-start install attempt produced UAC-related behavior. Second `printf 'y\ny\n' | hermes gateway install` succeeded and spawned the gateway directly.
- Confirmation: `hermes gateway status` showed `Gateway process running (PID: 6480)` and a registered `Hermes_Gateway` scheduled task.
- Verification caveat: on this host `~/.hermes/logs/gateway.log` was not present, so status CLI output is the authoritative check.