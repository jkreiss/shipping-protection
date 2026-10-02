import { afterEach, describe, expect, test, vi } from "vitest";
import process from "node:process";
import * as Sentry from "@sentry/node";
import { failureCode, reportFailure, scrubEvent, sentryOptions, workerHeartbeat } from "./observability.server.js";

vi.mock("@sentry/node", () => ({ init: vi.fn(), captureMessage: vi.fn(), captureCheckIn: vi.fn() }));

function capture() {
  const writes = [];
  vi.spyOn(process.stderr, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
  return () => writes.map((line) => JSON.parse(line));
}

afterEach(() => vi.restoreAllMocks());

class PrismaClientInitializationError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "PrismaClientInitializationError";
    this.errorCode = errorCode;
  }
}

describe("failure reports", () => {
  test("name the error class and the loop without the error message", () => {
    const logged = capture();
    const error = new Error("order #1001 for jane@example.com failed");

    reportFailure("worker_loop_failed", error, { loop: "delivery" });

    const [entry] = logged();
    expect(entry).toMatchObject({ event: "worker_loop_failed", code: "PROCESSING_ERROR", errorName: "Error", loop: "delivery" });
    expect(JSON.stringify(entry)).not.toContain("jane@example.com");
    expect(JSON.stringify(entry)).not.toContain("1001");
  });

  test("use the Prisma error code from errors that report it as errorCode", () => {
    const error = new PrismaClientInitializationError("Error querying the database: FATAL", "P1001");
    expect(failureCode(error)).toBe("P1001");

    const logged = capture();
    reportFailure("worker_loop_failed", error);
    expect(logged()[0]).toMatchObject({ code: "P1001", errorName: "PrismaClientInitializationError" });
  });

  test("never log an error name that could carry data", () => {
    const logged = capture();
    const error = new Error("boom");
    error.name = "jane@example.com";

    reportFailure("worker_loop_failed", error);

    expect(logged()[0].errorName).toBe("Error");
  });

  test("reports non-Error values without failing", () => {
    const logged = capture();
    reportFailure("worker_loop_failed", "a string with order data");
    expect(logged()[0]).toMatchObject({ code: "PROCESSING_ERROR", errorName: "Unknown" });
    expect(JSON.stringify(logged()[0])).not.toContain("order data");
  });
});

describe("Sentry events", () => {
  test("replace exception messages but keep the type and stack", () => {
    const event = scrubEvent({
      request: { url: "https://shop.example/orders/1001" },
      breadcrumbs: [{ message: "jane@example.com" }],
      extra: { order: 1001 },
      contexts: { os: {} },
      message: "webhook_terminal",
      exception: { values: [{ type: "Error", value: "order #1001 for jane@example.com failed", stacktrace: { frames: [{ function: "ingest" }] } }] },
    });

    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "[scrubbed]", stacktrace: { frames: [{ function: "ingest" }] } });
    expect(event).toMatchObject({ message: "webhook_terminal" });
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(event).not.toHaveProperty("extra");
    expect(event).not.toHaveProperty("contexts");
    expect(JSON.stringify(event)).not.toContain("jane@example.com");
  });

  test("handle events that have no exception", () => {
    expect(scrubEvent({ message: "x" })).toEqual({ message: "x" });
  });

  test("tag the deploy and service from Railway, and the environment from APP_ENV", () => {
    const options = sentryOptions({
      SENTRY_DSN: "https://dsn", APP_ENV: "staging", NODE_ENV: "production",
      RAILWAY_GIT_COMMIT_SHA: "abc123", RAILWAY_SERVICE_NAME: "worker",
    });
    expect(options).toMatchObject({
      dsn: "https://dsn", environment: "staging", release: "abc123",
      initialScope: { tags: { service: "worker" } }, sendDefaultPii: false, tracesSampleRate: 0, beforeSend: scrubEvent,
    });
  });

  test("omit release and service tags when Railway does not supply them", () => {
    const options = sentryOptions({ SENTRY_DSN: "https://dsn", NODE_ENV: "production" });
    expect(options.environment).toBe("production");
    expect(options).not.toHaveProperty("release");
    expect(options).not.toHaveProperty("initialScope");
  });
});

describe("worker heartbeat", () => {
  const env = { SENTRY_DSN: "https://dsn", SENTRY_WORKER_MONITOR: "worker-loop" };

  test("stays off unless a DSN and monitor slug are set", () => {
    expect(workerHeartbeat(10_000_000, {})).toBe(false);
    expect(workerHeartbeat(10_000_000, { SENTRY_DSN: "https://dsn" })).toBe(false);
    expect(workerHeartbeat(10_000_000, { SENTRY_WORKER_MONITOR: "worker-loop" })).toBe(false);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  test("checks in at most once a minute", () => {
    expect(workerHeartbeat(20_000_000, env)).toBe(true);
    expect(workerHeartbeat(20_000_000 + 59_000, env)).toBe(false);
    expect(workerHeartbeat(20_000_000 + 60_000, env)).toBe(true);
    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(Sentry.captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: "worker-loop", status: "ok" },
      expect.objectContaining({ schedule: { type: "interval", value: 5, unit: "minute" } }),
    );
  });
});
