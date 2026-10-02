import * as Sentry from "@sentry/node";

// Events carry only safe tags. Error messages can hold order or customer data,
// so exception text is replaced; the type and stack still group and locate it.
export function scrubEvent(event) {
  delete event.request;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.contexts;
  for (const exception of event.exception?.values ?? []) exception.value = "[scrubbed]";
  return event;
}

// Railway supplies the commit and service name, tying each event to a deploy
// and telling the web service from the worker.
export function sentryOptions(env = process.env) {
  const service = env.RAILWAY_SERVICE_NAME;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV ?? env.NODE_ENV,
    ...(env.RAILWAY_GIT_COMMIT_SHA ? { release: env.RAILWAY_GIT_COMMIT_SHA } : {}),
    ...(service ? { initialScope: { tags: { service } } } : {}),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  };
}

if (process.env.SENTRY_DSN) Sentry.init(sentryOptions());

// Optional liveness signal for the worker: set SENTRY_WORKER_MONITOR to a Sentry
// Cron monitor slug and Sentry alerts when check-ins stop arriving.
const HEARTBEAT_EVERY_MS = 60_000;
let lastHeartbeat = 0;
export function workerHeartbeat(now = Date.now(), env = process.env) {
  const monitorSlug = env.SENTRY_WORKER_MONITOR;
  if (!env.SENTRY_DSN || !monitorSlug || now - lastHeartbeat < HEARTBEAT_EVERY_MS) return false;
  lastHeartbeat = now;
  Sentry.captureCheckIn(
    { monitorSlug, status: "ok" },
    { schedule: { type: "interval", value: 5, unit: "minute" }, checkinMargin: 5, maxRuntime: 5 },
  );
  return true;
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
