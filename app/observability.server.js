import * as Sentry from "@sentry/node";

const PRISMA_CODE = /^P\d{4}$/;
// Only class-like names such as PrismaClientInitializationError: never free text.
const ERROR_CLASS_NAME = /^(?:[A-Z][A-Za-z0-9]{0,62})?Error$/;
// Event names are snake_case identifiers fixed in code, e.g. webhook_terminal.
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// The privacy policy promises Sentry error type, code location and deploy
// version only. These fields name a code path from a fixed vocabulary; shop,
// order, customer and amount fields stay in the logs, which carry the Sentry
// event ID to match them up.
const SENTRY_TAG_FIELDS = ["topic", "loop", "operation", "method"];

// Events carry only safe tags. Error messages can hold order or customer data,
// so exception text becomes the event name (which keeps issue titles such as
// "HttpResponseError: webhook_terminal") and free-text types become "Error";
// the stack still groups and locates it.
export function scrubEvent(event) {
  delete event.request;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.contexts;
  delete event.user;
  delete event.server_name;
  const tag = event.tags?.event;
  const value = typeof tag === "string" && EVENT_NAME.test(tag) ? tag : "[scrubbed]";
  for (const exception of event.exception?.values ?? []) {
    exception.value = value;
    if (typeof exception.type !== "string" || !ERROR_CLASS_NAME.test(exception.type)) exception.type = "Error";
  }
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
// Cron monitor slug and Sentry alerts when check-ins stop arriving. Each worker
// loop reports in, and the check-in is sent only while every expected loop has
// done so recently, so one hung loop silences it even if the others keep going.
const HEARTBEAT_EVERY_MS = 60_000;
// A reconciliation turn on one shop is time-boxed to a minute; allow a few.
const LOOP_STALE_MS = 3 * 60_000;
const loopSeen = new Map();
let lastHeartbeat = 0;

export function expectWorkerLoops(names, now = Date.now()) {
  loopSeen.clear();
  for (const name of names) loopSeen.set(name, now);
}

export function workerHeartbeat(loop, now = Date.now(), env = process.env) {
  loopSeen.set(loop, now);
  const monitorSlug = env.SENTRY_WORKER_MONITOR;
  if (!env.SENTRY_DSN || !monitorSlug || now - lastHeartbeat < HEARTBEAT_EVERY_MS) return false;
  for (const seen of loopSeen.values()) if (now - seen > LOOP_STALE_MS) return false;
  lastHeartbeat = now;
  Sentry.captureCheckIn(
    { monitorSlug, status: "ok" },
    { schedule: { type: "interval", value: 5, unit: "minute" }, checkinMargin: 5, maxRuntime: 5 },
  );
  return true;
}

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

// The error's class, e.g. "HttpRequestError". Subclasses that never set name
// report "Error" there, so the constructor's name wins over the generic one.
// Error messages are never logged: they can contain order or customer data.
export function errorName(error) {
  if (!error || typeof error !== "object") return "Unknown";
  const names = [error.name, error.constructor?.name]
    .filter((name) => typeof name === "string" && ERROR_CLASS_NAME.test(name));
  return names.find((name) => name !== "Error") ?? "Error";
}

function sentryTags(event, fields, extra = {}) {
  const tags = { event, ...extra };
  for (const key of SENTRY_TAG_FIELDS) if (typeof fields[key] === "string") tags[key] = fields[key];
  return tags;
}

function writeError(entry, sentryEventId) {
  process.stderr.write(`${JSON.stringify({ ...entry, ...(sentryEventId ? { sentryEventId } : {}) })}\n`);
}

export function reportFailure(event, error, fields = {}) {
  const code = failureCode(error);
  const name = errorName(error);
  let sentryEventId;
  if (process.env.SENTRY_DSN) {
    // A thrown non-Error is replaced so nothing it holds is serialized. The
    // fingerprint keeps different events apart even when they share a stack.
    sentryEventId = Sentry.captureException(error instanceof Error ? error : new Error(event), {
      level: "error",
      tags: sentryTags(event, fields, { code, errorName: name }),
      fingerprint: ["{{ default }}", event],
    });
  }
  writeError({ level: "error", event, code, errorName: name, at: new Date().toISOString(), ...fields }, sentryEventId);
}

// An operator alert for a state that is not an exception, such as a sync that
// has fallen behind. Sent at error level so the same alert rules apply.
export function reportCondition(event, fields = {}) {
  const sentryEventId = process.env.SENTRY_DSN
    ? Sentry.captureMessage(event, { level: "error", tags: sentryTags(event, fields) })
    : undefined;
  writeError({ level: "error", event, at: new Date().toISOString(), ...fields }, sentryEventId);
}
