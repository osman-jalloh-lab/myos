import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,         // 10% of transactions — keeps quota low
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,   // no session replays — privacy
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});
