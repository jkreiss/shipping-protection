import process from "node:process";
import { processNextDelivery, workerConcurrency } from "./webhook-worker.server.js";
import { reconcileOrders, reconciliationDue, shopsToReportBehind } from "./order-reconciliation.server.js";
import { expectWorkerLoops, logEvent, reportCondition, reportFailure, workerHeartbeat } from "./observability.server.js";
import { isAccessLost } from "./shopify/admin-graphql.server.js";
import { purgeExpiredOrders, RETENTION_INTERVAL_MS } from "./order-retention.server.js";

// The worker's delivery and reconciliation loops; the reconciliation loop also
// runs the daily retention purge. scripts/worker.js supplies
// Prisma and Shopify; tests supply doubles. stop() lets each loop finish its
// current batch, then run() disconnects and resolves.
export function createWorkerRuntime({
  database,
  adminForShop,
  concurrency = workerConcurrency(process.env.WORKER_CONCURRENCY),
  processDelivery = processNextDelivery,
  reconcile = reconcileOrders,
  pollMs = 2_000,
  reconcileIdleMs = 30_000,
  reconcileFailureBackoffMs = 5 * 60_000,
  purgeOrders = purgeExpiredOrders,
  retentionIntervalMs = RETENTION_INTERVAL_MS,
  retentionFailureBackoffMs = 60 * 60_000,
}) {
  // In-memory only: a restart simply retries failed shops sooner and purges
  // again on start, which finds little to delete.
  const reconcileRetryAt = new Map();
  const behindReportedAt = new Map();
  let retentionDueAt = 0;
  // Shops whose purge failed this run; skipped until the run completes so one
  // shop isn't retried (and reported) every turn.
  let retentionFailedShops = new Set();
  let stopping = false;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function pauseUnlessStopping(ms) {
    for (let waited = 0; waited < ms && !stopping; waited += pollMs) await pause(Math.min(pollMs, ms - waited));
  }

  async function reconcileShop(shop) {
    const started = Date.now();
    try {
      const { admin } = await adminForShop(shop.shopDomain);
      const result = await reconcile({ admin, shopDomain: shop.shopDomain, database,
        onProgress: () => workerHeartbeat("reconciliation") });
      reconcileRetryAt.delete(shop.id);
      logEvent(result.superseded ? "reconciliation_superseded" : "reconciliation_completed", { shopId: shop.id, pages: result.pages,
        ordersListed: result.ordersListed, ordersFetched: result.ordersFetched, ordersFailed: result.ordersFailed, ordersSkipped: result.ordersSkipped,
        complete: result.complete, windowEnd: result.windowEnd, durationMs: Date.now() - started });
    } catch (error) {
      // Back off so a shop that keeps failing isn't retried in a tight loop.
      reconcileRetryAt.set(shop.id, Date.now() + reconcileFailureBackoffMs);
      // Lost access means the shop is uninstalling; its webhook will mark it so.
      if (isAccessLost(error)) logEvent("reconciliation_skipped_access_lost", { shopId: shop.id });
      else reportFailure("reconciliation_failed", error, { shopId: shop.id, durationMs: Date.now() - started });
    }
  }

  // One pass over installed shops, working on each shop that is due. A shop
  // still backfilling gets one time-boxed turn per pass, so other shops keep up.
  async function reconciliationPass() {
    const shops = await database.shop.findMany({
      where: { installationState: "INSTALLED" }, orderBy: { id: "asc" },
      select: { id: true, shopDomain: true, orderReconciliationSince: true, orderReconciliationCursor: true, orderReconciliationUntil: true },
    });
    for (const { shopId, minutesBehind } of shopsToReportBehind(shops, behindReportedAt)) {
      reportCondition("order_sync_behind", { shopId, minutesBehind });
    }
    let worked = false;
    for (const shop of shops) {
      if (stopping) break;
      workerHeartbeat("reconciliation");
      if (!reconciliationDue(shop) || (reconcileRetryAt.get(shop.id) ?? 0) > Date.now()) continue;
      worked = true;
      await reconcileShop(shop);
    }
    return worked;
  }

  // Runs at most once per interval. Each turn is time-boxed; an unfinished purge
  // continues on the next pass, after reconciliation has had its turn. A failure
  // retries after a backoff rather than every pass. A shop that fails is
  // reported, skipped for the rest of the run, and retried next run.
  async function retentionPass(now = Date.now()) {
    if (now < retentionDueAt) return false;
    const started = Date.now();
    try {
      const result = await purgeOrders({
        database, shouldStop: () => stopping, onProgress: () => workerHeartbeat("reconciliation"),
        skipShopIds: [...retentionFailedShops],
        onShopFailure: (shopId, error) => reportFailure("retention_shop_failed", error, { shopId }),
      });
      for (const shopId of result.failedShopIds) retentionFailedShops.add(shopId);
      const shopsFailed = retentionFailedShops.size;
      if (result.complete) retentionFailedShops = new Set();
      retentionDueAt = result.complete ? now + retentionIntervalMs : now;
      logEvent(result.complete ? "retention_purge_completed" : "retention_purge_paused", {
        ordersDeleted: result.ordersDeleted, deliveriesDeleted: result.deliveriesDeleted, shopsFailed,
        cutoff: result.cutoff.toISOString(), durationMs: Date.now() - started,
      });
    } catch (error) {
      retentionDueAt = now + retentionFailureBackoffMs;
      reportFailure("retention_purge_failed", error, { durationMs: Date.now() - started });
    }
    return true;
  }

  // Each loop claims one order's queued deliveries at a time; an empty queue
  // makes it wait before polling again. A loop finishes its current batch on stop.
  async function deliveryLoop(id) {
    while (!stopping) {
      workerHeartbeat(`delivery-${id}`);
      try {
        if (await processDelivery({ database, adminForShop })) continue;
      } catch (error) {
        reportFailure("worker_loop_failed", error, { loop: "delivery" });
      }
      if (!stopping) await pause(pollMs);
    }
  }

  async function reconciliationLoop() {
    while (!stopping) {
      workerHeartbeat("reconciliation");
      await retentionPass();
      let worked = false;
      try {
        worked = await reconciliationPass();
      } catch (error) {
        reportFailure("worker_loop_failed", error, { loop: "reconciliation" });
      }
      if (!worked) await pauseUnlessStopping(reconcileIdleMs);
    }
  }

  async function run() {
    logEvent("worker_started", { concurrency });
    expectWorkerLoops(["reconciliation", ...Array.from({ length: concurrency }, (_, id) => `delivery-${id}`)]);
    try {
      await Promise.all([
        ...Array.from({ length: concurrency }, (_, id) => deliveryLoop(id)),
        reconciliationLoop(),
      ]);
    } finally {
      await database.$disconnect();
      logEvent("worker_stopped");
    }
  }

  return { run, stop: () => { stopping = true; }, reconciliationPass, retentionPass };
}
