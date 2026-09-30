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

const PRISMA_CODE = /^P\d{4}$/;
// Only class-like names such as PrismaClientInitializationError: never free text.
const ERROR_CLASS_NAME = /^(?:[A-Z][A-Za-z0-9]{0,62})?Error$/;

export function failureCode(error) {
  if (typeof error?.code === "string" && PRISMA_CODE.test(error.code)) return error.code;
  // PrismaClientInitializationError reports its code as errorCode.
  if (typeof error?.errorCode === "string" && PRISMA_CODE.test(error.errorCode)) return error.errorCode;
  if (error instanceof RangeError) return "RANGE_ERROR";
  if (error instanceof TypeError) return "TYPE_ERROR";
  return "PROCESSING_ERROR";
}

export function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", event, at: new Date().toISOString(), ...fields })}\n`);
}

// The error's class, e.g. "HttpRequestError". Error messages are never logged:
// they can contain order or customer data.
export function errorName(error) {
  if (!error || typeof error !== "object") return "Unknown";
  for (const name of [error.name, error.constructor?.name]) {
    if (typeof name === "string" && ERROR_CLASS_NAME.test(name)) return name;
  }
  return "Error";
}

export function reportFailure(event, error, fields = {}) {
  const code = failureCode(error);
  const name = errorName(error);
  process.stderr.write(`${JSON.stringify({ level: "error", event, code, errorName: name, at: new Date().toISOString(), ...fields })}\n`);
  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(event, { level: "error", tags: { code, errorName: name, ...fields } });
  }
}
