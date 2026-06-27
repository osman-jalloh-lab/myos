# Hermes Local Worker

The local worker must know which Mission Control / queue deployment to call. For local development this is normally `http://localhost:3000`; for production it must be the deployed Parawi URL.

Set the worker target in `.env.local` before starting it:

```env
HERMES_WORKER_API_BASE_URL=https://www.parawi.com
```

Use the correct deployed URL if production is hosted elsewhere. The fallback order is `HERMES_WORKER_API_BASE_URL`, `NEXT_PUBLIC_APP_URL`, a usable `VERCEL_URL`, then `http://localhost:3000`.

Run `npm run worker:local`. Startup prints the selected base URL. The worker checks `/api/worker/health` before recording an online heartbeat; failures include the target URL, HTTP status or sanitized error, and whether the failure appears to be DNS/network related. Secrets are never included in these diagnostics.
