import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  enabled: !!(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),

  // Never send LLM prompt content or personal data to Sentry
  beforeSend(event) {
    if (event.request?.data) {
      event.request.data = "[redacted]";
    }
    return event;
  },
});
