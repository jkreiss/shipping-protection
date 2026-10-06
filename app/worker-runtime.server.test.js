import { beforeEach, describe, expect, test, vi } from "vitest";
import { expectWorkerLoops, reportCondition, reportFailure, workerHeartbeat } from "./observability.server.js";
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
});
