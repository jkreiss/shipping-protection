import { afterEach, describe, expect, test, vi } from "vitest";
import process from "node:process";
import * as Sentry from "@sentry/node";
import { errorName, failureCode, reportCondition, reportFailure, scrubEvent, sentryOptions, expectWorkerLoops, workerHeartbeat } from "./observability.server.js";

vi.mock("@sentry/node", () => ({ init: vi.fn(), captureMessage: vi.fn(), captureException: vi.fn(), captureCheckIn: vi.fn() }));

function capture() {
  const writes = [];
  vi.spyOn(process.stderr, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
  return () => writes.map((line) => JSON.parse(line));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

class PrismaClientInitializationError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "PrismaClientInitializationError";
    this.errorCode = errorCode;
  }
}

// Like Shopify's API errors: a subclass that never sets name, so name is "Error".
class HttpResponseError extends Error {}

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

  test("name the subclass when the error's name is the generic Error", () => {
    expect(errorName(new HttpResponseError("order #1001"))).toBe("HttpResponseError");
    expect(errorName(new Error("x"))).toBe("Error");
  });

  test("send the exception to Sentry with only code-path tags, and log its event ID", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    Sentry.captureException.mockReturnValue("evt-1");
    const logged = capture();
    const error = new HttpResponseError("order #1001 failed");

    reportFailure("webhook_retry", error, {
      shop: "one.myshopify.com", shopId: "shop-1", shopifyOrderId: "gid://shopify/Order/1001",
      chargedFeeAmount: "4.00", intent: "anything a form sent", path: "/app/claims/7", topic: "ORDERS_PAID",
    });

    const [sent, context] = Sentry.captureException.mock.calls[0];
    expect(context).toEqual({
      level: "error",
      tags: { event: "webhook_retry", code: "PROCESSING_ERROR", errorName: "HttpResponseError", topic: "ORDERS_PAID" },
      fingerprint: ["{{ default }}", "webhook_retry"],
    });
    expect(sent).not.toBe(error);
    expect(sent).toMatchObject({ name: "HttpResponseError", message: "webhook_retry" });
    expect(sent.stack).not.toContain("order #1001");
    expect(sent.stack.split("\n").slice(1)).toEqual(error.stack.split("\n").slice(1));
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "webhook_retry", shopId: "shop-1", sentryEventId: "evt-1" });
  });

  test("send each report of the same error, which Sentry would otherwise drop as already captured", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    capture();
    const error = new Error("Shopify returned no GraphQL data.");

    reportFailure("shopify_graphql_failed", error, { operation: "OrderForIngestion" });
    reportFailure("webhook_terminal", error, { topic: "ORDERS_PAID" });

    const [[first], [second]] = Sentry.captureException.mock.calls;
    expect(first).not.toBe(second);
    expect([first.message, second.message]).toEqual(["shopify_graphql_failed", "webhook_terminal"]);
  });

  test("send a stand-in exception for a thrown non-Error value", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    capture();
    reportFailure("worker_loop_failed", "a string with order data", { loop: "delivery" });
    const [sent, context] = Sentry.captureException.mock.calls[0];
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toBe("worker_loop_failed");
    expect(context.tags).toEqual({ event: "worker_loop_failed", code: "PROCESSING_ERROR", errorName: "Unknown", loop: "delivery" });
  });

  test("send nothing to Sentry and log no event ID without a DSN", () => {
    vi.stubEnv("SENTRY_DSN", "");
    const logged = capture();
    reportFailure("worker_loop_failed", new Error("x"));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logged()[0]).not.toHaveProperty("sentryEventId");
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

  test("puts the event name in the exception value and drops free-text types, user and host", () => {
    const event = scrubEvent({
      tags: { event: "webhook_terminal" },
      user: { ip_address: "1.2.3.4" },
      server_name: "railway-host",
      exception: { values: [
        { type: "HttpResponseError", value: "order #1001 failed" },
        { type: "jane@example.com", value: "cause with data" },
      ] },
    });
    expect(event.exception.values).toEqual([
      { type: "HttpResponseError", value: "webhook_terminal" },
      { type: "Error", value: "webhook_terminal" },
    ]);
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("server_name");
    expect(JSON.stringify(event)).not.toContain("jane@example.com");
  });

  test("scrub the exception value when the event tag is not a plain event name", () => {
    const event = scrubEvent({ tags: { event: "order 1001 failed" }, exception: { values: [{ type: "Error", value: "x" }] } });
    expect(event.exception.values[0].value).toBe("[scrubbed]");
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
  const loops = ["delivery-0", "reconciliation"];

  test("stays off unless a DSN and monitor slug are set", () => {
    expectWorkerLoops(loops, 10_000_000);
    expect(workerHeartbeat("delivery-0", 10_000_000, {})).toBe(false);
    expect(workerHeartbeat("delivery-0", 10_000_000, { SENTRY_DSN: "https://dsn" })).toBe(false);
    expect(workerHeartbeat("delivery-0", 10_000_000, { SENTRY_WORKER_MONITOR: "worker-loop" })).toBe(false);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  test("checks in at most once a minute while every loop is alive", () => {
    expectWorkerLoops(loops, 20_000_000);
    expect(workerHeartbeat("delivery-0", 20_000_000, env)).toBe(true);
    expect(workerHeartbeat("reconciliation", 20_000_000 + 59_000, env)).toBe(false);
    expect(workerHeartbeat("delivery-0", 20_000_000 + 60_000, env)).toBe(true);
    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(Sentry.captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: "worker-loop", status: "ok" },
      expect.objectContaining({ schedule: { type: "interval", value: 5, unit: "minute" } }),
    );
  });

  test("stops checking in when a loop that was running goes quiet", () => {
    expectWorkerLoops(loops, 30_000_000);
    expect(workerHeartbeat("reconciliation", 30_000_000, env)).toBe(true);
    // Only the delivery loop keeps ticking; the reconciliation loop is hung.
    expect(workerHeartbeat("delivery-0", 30_000_000 + 120_000, env)).toBe(true);
    expect(workerHeartbeat("delivery-0", 30_000_000 + 4 * 60_000, env)).toBe(false);
    expect(Sentry.captureCheckIn).toHaveBeenCalledTimes(2);
  });

  test("stops checking in when a loop never starts", () => {
    expectWorkerLoops(loops, 40_000_000);
    expect(workerHeartbeat("delivery-0", 40_000_000 + 4 * 60_000, env)).toBe(false);
    expect(Sentry.captureCheckIn).not.toHaveBeenCalled();
  });
});

describe("condition reports", () => {
  test("log an error-level event with its fields and no error details", () => {
    const logged = capture();
    reportCondition("order_sync_behind", { shopId: "shop_1", minutesBehind: 45 });
    const [entry] = logged();
    expect(entry).toMatchObject({ level: "error", event: "order_sync_behind", shopId: "shop_1", minutesBehind: 45 });
    expect(entry).not.toHaveProperty("code");
    expect(entry).not.toHaveProperty("errorName");
  });

  test("send Sentry only the event name, keeping shop fields in the log", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    Sentry.captureMessage.mockReturnValue("evt-2");
    const logged = capture();
    reportCondition("order_sync_behind", { shopId: "shop_1", minutesBehind: 45 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith("order_sync_behind", { level: "error", tags: { event: "order_sync_behind" } });
    expect(logged()[0]).toMatchObject({ shopId: "shop_1", sentryEventId: "evt-2" });
  });
});
