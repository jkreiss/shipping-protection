import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.contexts;
      return event;
    },
  });
}

export function failureCode(error) {
  if (typeof error?.code === "string" && /^P\d{4}$/.test(error.code)) return error.code;
  if (error instanceof RangeError) return "RANGE_ERROR";
  if (error instanceof TypeError) return "TYPE_ERROR";
  return "PROCESSING_ERROR";
}

export function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", event, at: new Date().toISOString(), ...fields })}\n`);
}

export function reportFailure(event, error, fields = {}) {
  const code = failureCode(error);
  process.stderr.write(`${JSON.stringify({ level: "error", event, code, at: new Date().toISOString(), ...fields })}\n`);
  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(event, { level: "error", tags: { code, ...fields } });
  }
}
