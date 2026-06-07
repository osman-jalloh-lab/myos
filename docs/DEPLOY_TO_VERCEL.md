# DEPLOY_TO_VERCEL.md — Hermes OS deployment runbook

> Goal: get Hermes live on Vercel with as little back-and-forth as possible. Follow top to bottom. Pairs with `vercel.json`, `next.config.mjs`, `.env.example`, `package.json` in the repo root.

---

## The one tradeoff (read first)

Vercel is serverless. It **cannot run a persistent Ollama**. So:
- Default model routing is **Groq** (cheap) with OpenAI / Claude on demand.
- If you want email / I-9 / finance to stay truly local, run Ollama on your home machine and expose it through a **Cloudflare Tunnel**, then set `OLLAMA_BASE_URL` to that tunnel URL. Optional. Not needed to launch.

---

## 0. Stack (pinned — do not diverge)

Next.js (App Router) · NextAuth v5 (Auth.js) · Prisma + `@prisma/adapter-libsql` · Turso (libSQL) · Vercel hosting + Vercel Cron. This matches the Parawi stack.

---

## 1. Turso database

```bash
# install once
curl -sSfL https://get.tur.so/install.sh | bash

turso auth login
turso db create hermes
turso db show hermes --url            # -> TURSO_DATABASE_URL
turso db tokens create hermes         # -> TURSO_AUTH_TOKEN
```
Copy both values. You will paste them into Vercel env vars in step 4.

Prisma uses the libSQL adapter (not a direct Postgres URL). In `schema.prisma`:
```prisma
datasource db { provider = "sqlite"; url = "file:./dev.db" }  // adapter overrides at runtime
generator client { provider = "prisma-client-js"; previewFeatures = ["driverAdapters"] }
```
Run migrations against Turso with the libSQL adapter, not `prisma migrate deploy` against a Postgres URL.

---

## 2. Google OAuth (this is the part that caused trouble before — do it exactly)

Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client (Web application).

**Authorized JavaScript origins:**
```
http://localhost:3000
https://hermes.<your-domain>
https://<project>.vercel.app
```

**Authorized redirect URIs** (NextAuth v5 callback path is `/api/auth/callback/google`):
```
http://localhost:3000/api/auth/callback/google
https://hermes.<your-domain>/api/auth/callback/google
https://<project>.vercel.app/api/auth/callback/google
```

Gotchas that cause `redirect_uri_mismatch`:
- The redirect URI must match **exactly** — scheme, host, path, no trailing slash.
- Vercel **preview** deployments get random URLs. They will not match. For previews, either test OAuth only on production/localhost, or assign a stable preview alias domain and add its callback URI too.
- Set `NEXTAUTH_URL=https://hermes.<your-domain>` in production. If it is wrong, NextAuth builds the wrong callback and Google rejects it.

Enable the **Gmail API** and **Google Calendar API** in the same project. Phase 1 scopes: `openid email profile calendar.readonly`. Add Gmail scopes only when the approval queue exists.

---

## 3. Vercel project

1. Push the repo to GitHub.
2. Vercel → Add New Project → import the repo. Framework auto-detects Next.js.
3. Build command `next build`, output auto. No special install command needed.
4. Vercel → Project → Domains → add `hermes.<your-domain>`, follow the DNS records it shows.

---

## 4. Environment variables (Vercel → Settings → Environment Variables)

Add every key from `.env.example`. The ones that block launch if missing or wrong:
- `NEXTAUTH_URL` = your production URL (no trailing slash)
- `NEXTAUTH_SECRET` = `openssl rand -base64 32`
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` = from the Google client
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` = from step 1
- `GROQ_API_KEY` = default model provider
- `CRON_SECRET` = `openssl rand -hex 16` (guards cron routes)

Set them for Production (and Preview/Development if you test there). Redeploy after adding.

---

## 5. Cron (daily brief + weekly scouts)

`vercel.json` already declares the schedules. Each cron route must check the secret:
```ts
// app/api/cron/daily-brief/route.ts
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ...generate brief, save to daily_briefs
}
```
**Hobby-tier limit:** Vercel Hobby crons run roughly once per day and not at an exact minute. For reliable weekly scouts or precise 7:30 AM timing, either upgrade to Pro or trigger the routes from an external scheduler (cron-job.org or a GitHub Actions schedule) hitting the same URLs with the `CRON_SECRET`.

Cron schedules in `vercel.json` are **UTC**. 7:30 AM America/Chicago = `30 12 * * *` in summer (CDT) and `30 13 * * *` in winter (CST). Pick one; adjust at the DST switch, or compute the offset in the handler.

---

## 6. Serverless limits to design around (avoids silent failures)

- Function `maxDuration` is capped (60s on Hobby). Keep LLM calls fast; for long jobs, stream or split into steps. Do not block a request on a multi-minute model call.
- No persistent processes, no local file writes that must survive — use Turso for all state.
- No Ollama on Vercel (see top). Sensitive routing falls back to Groq unless a tunnel is configured.

---

## 7. Launch checklist

- [ ] Turso db created, URL + token in Vercel
- [ ] Google OAuth origins + redirect URIs added exactly, Gmail + Calendar APIs enabled
- [ ] All env vars set in Vercel (NEXTAUTH_URL correct, NEXTAUTH_SECRET set)
- [ ] Custom domain added and DNS verified
- [ ] `vercel.json` crons present; cron routes check `CRON_SECRET`
- [ ] First deploy green; sign-in with Google works on the production domain
- [ ] No Gmail send scope until the approval queue exists
