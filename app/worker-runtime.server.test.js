import { beforeEach, describe, expect, test, vi } from "vitest";
import { expectWorkerLoops, logEvent, reportCondition, reportFailure, workerHeartbeat } from "./observability.server.js";
import { createWorkerRuntime } from "./worker-runtime.server.js";

vi.mock("./observability.server.js", () => ({
  expectWorkerLoops: vi.fn(), logEvent: vi.fn(), reportCondition: vi.fn(), reportFailure: vi.fn(), workerHeartbeat: vi.fn(),
}));

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);

function databaseWith(shops) {
  return { shop: { findMany: vi.fn().mockResolvedValue(shops) }, $disconnect: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());

describe("worker runtime", () => {
  test("on stop, finishes in-flight deliveries, claims nothing new, and disconnects once", async () => {
    let release;
    const inFlight = new Promise((resolve) => { release = resolve; });
    const database = databaseWith([]);
    const processDelivery = vi.fn(async () => { await inFlight; return true; });
    const runtime = createWorkerRuntime({ database, adminForShop: vi.fn(), processDelivery, concurrency: 2, pollMs: 5 });

    const finished = runtime.run();
    await Promise.resolve();
    expect(expectWorkerLoops).toHaveBeenCalledWith(["reconciliation", "delivery-0", "delivery-1"]);
    runtime.stop();
    expect(database.$disconnect).not.toHaveBeenCalled();
    release();
    await finished;

    expect(processDelivery).toHaveBeenCalledTimes(2);
    expect(processDelivery).toHaveBeenCalledWith({ database, adminForShop: expect.any(Function) });
    expect(database.$disconnect).toHaveBeenCalledTimes(1);
    expect(workerHeartbeat).toHaveBeenCalledWith("delivery-0");
    expect(workerHeartbeat).toHaveBeenCalledWith("delivery-1");
  });

  test("backs off a failing shop and keeps reconciling the others", async () => {
    const shops = [{ id: "bad", shopDomain: "bad.myshopify.com" }, { id: "good", shopDomain: "good.myshopify.com" }];
    const database = databaseWith(shops);
    const adminForShop = vi.fn(async (domain) => {
      if (domain.startsWith("bad")) throw new Error("offline");
      return { admin: {} };
    });
    const reconcile = vi.fn(async ({ onProgress }) => { onProgress(); return {}; });
    const runtime = createWorkerRuntime({ database, adminForShop, reconcile, concurrency: 1 });

    await runtime.reconciliationPass();
    await runtime.reconciliationPass();

    expect(adminForShop.mock.calls.map(([domain]) => domain))
      .toEqual(["bad.myshopify.com", "good.myshopify.com", "good.myshopify.com"]);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ shopDomain: "good.myshopify.com", database }));
    expect(reportFailure).toHaveBeenCalledWith("reconciliation_failed", expect.any(Error), expect.objectContaining({ shopId: "bad" }));
    // Progress inside a long reconciliation turn keeps the heartbeat alive.
    expect(vi.mocked(workerHeartbeat).mock.calls.filter(([loop]) => loop === "reconciliation").length).toBeGreaterThanOrEqual(4);
  });

  test("backs off quietly from a shop the app has lost access to", async () => {
    const database = databaseWith([{ id: "gone", shopDomain: "gone.myshopify.com" }]);
    const SessionNotFoundError = class SessionNotFoundError extends Error {};
    const adminForShop = vi.fn(async () => { throw new SessionNotFoundError("no session"); });
    const runtime = createWorkerRuntime({ database, adminForShop, reconcile: vi.fn(), concurrency: 1 });

    await runtime.reconciliationPass();
    await runtime.reconciliationPass();

    expect(adminForShop).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("reconciliation_skipped_access_lost", { shopId: "gone" });
  });

  test("reports a shop whose sync has fallen behind, once per reporting interval", async () => {
    const shops = [
      { id: "behind", shopDomain: "behind.myshopify.com", orderReconciliationSince: minutesAgo(45), orderReconciliationCursor: null },
      { id: "current", shopDomain: "current.myshopify.com", orderReconciliationSince: minutesAgo(1), orderReconciliationCursor: null },
    ];
    const runtime = createWorkerRuntime({
      database: databaseWith(shops), adminForShop: async () => ({ admin: {} }), reconcile: async () => ({}), concurrency: 1,
    });

    await runtime.reconciliationPass();
    await runtime.reconciliationPass();

    expect(reportCondition).toHaveBeenCalledTimes(1);
    expect(reportCondition).toHaveBeenCalledWith("order_sync_behind", { shopId: "behind", minutesBehind: 45 });
  });

  test("purges expired orders at most once per interval", async () => {
    const cutoff = new Date("2024-10-07T00:00:00.000Z");
    const purgeOrders = vi.fn(async ({ onProgress }) => { onProgress(); return { cutoff, ordersDeleted: 3, deliveriesDeleted: 1, complete: true }; });
    const runtime = createWorkerRuntime({
      database: databaseWith([]), adminForShop: vi.fn(), purgeOrders, retentionIntervalMs: 1_000, concurrency: 1,
    });

    expect(await runtime.retentionPass(10_000)).toBe(true);
    expect(await runtime.retentionPass(10_999)).toBe(false);
    expect(await runtime.retentionPass(11_000)).toBe(true);

    expect(purgeOrders).toHaveBeenCalledTimes(2);
    expect(workerHeartbeat).toHaveBeenCalledWith("reconciliation");
    expect(logEvent).toHaveBeenCalledWith("retention_purge_completed", expect.objectContaining({
      ordersDeleted: 3, deliveriesDeleted: 1, cutoff: cutoff.toISOString(),
    }));
  });

  test("continues an unfinished purge on the next pass", async () => {
    const cutoff = new Date("2024-10-07T00:00:00.000Z");
    const purgeOrders = vi.fn()
      .mockResolvedValueOnce({ cutoff, ordersDeleted: 500, deliveriesDeleted: 0, complete: false })
      .mockResolvedValueOnce({ cutoff, ordersDeleted: 20, deliveriesDeleted: 4, complete: true });
    const runtime = createWorkerRuntime({
      database: databaseWith([]), adminForShop: vi.fn(), purgeOrders, retentionIntervalMs: 1_000, concurrency: 1,
    });

    await runtime.retentionPass(5_000);
    await runtime.retentionPass(5_001);
    expect(await runtime.retentionPass(5_002)).toBe(false);

    expect(purgeOrders).toHaveBeenCalledTimes(2);
    expect(purgeOrders).toHaveBeenCalledWith(expect.objectContaining({ shouldStop: expect.any(Function) }));
    expect(logEvent).toHaveBeenCalledWith("retention_purge_paused", expect.objectContaining({ ordersDeleted: 500 }));
    expect(logEvent).toHaveBeenCalledWith("retention_purge_completed", expect.objectContaining({ ordersDeleted: 20 }));
  });

  test("retries a failed purge after the backoff instead of every pass", async () => {
    const purgeOrders = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const runtime = createWorkerRuntime({
      database: databaseWith([]), adminForShop: vi.fn(), purgeOrders,
      retentionIntervalMs: 10_000, retentionFailureBackoffMs: 500, concurrency: 1,
    });

    await runtime.retentionPass(1_000);
    expect(await runtime.retentionPass(1_499)).toBe(false);
    await runtime.retentionPass(1_500);

    expect(purgeOrders).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith("retention_purge_failed", expect.any(Error), expect.any(Object));
  });
});

test("superseded reconciliation turns retry without failure backoff or alerts", async () => {
  let turns = 0;
  const runtime = createWorkerRuntime({
    database: databaseWith([{ id: "shop", shopDomain: "one.myshopify.com" }]),
    adminForShop: async () => ({ admin: {} }),
    reconcile: async () => {
      turns++;
      return { complete: false, superseded: true };
    },
  });
  await runtime.reconciliationPass();
  await runtime.reconciliationPass();
  expect(turns).toBe(2);
  expect(reportFailure).not.toHaveBeenCalled();
  expect(logEvent).toHaveBeenCalledWith(
    "reconciliation_superseded",
    expect.objectContaining({ shopId: "shop" }),
  );
});
