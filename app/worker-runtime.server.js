import process from "node:process";
import { processNextDelivery, workerConcurrency } from "./webhook-worker.server.js";
import { reconcileOrders, reconciliationDue, shopsToReportBehind } from "./order-reconciliation.server.js";
import { expectWorkerLoops, logEvent, reportCondition, reportFailure, workerHeartbeat } from "./observability.server.js";
import { isAccessLost } from "./shopify/admin-graphql.server.js";
import { runBillingPass } from "./billing/billing-pass.server.js";

// The worker's delivery, reconciliation and billing loops. scripts/worker.js supplies
// Prisma and Shopify; tests supply doubles. stop() lets each loop finish its
// current batch, then run() disconnects and resolves.
export function createWorkerRuntime({
  database,
  adminForShop,
  concurrency = workerConcurrency(process.env.WORKER_CONCURRENCY),
  processDelivery = processNextDelivery,
  reconcile = reconcileOrders,
  billingPass = runBillingPass,
  pollMs = 2_000,
  reconcileIdleMs = 30_000,
  reconcileFailureBackoffMs = 5 * 60_000,
  billingIntervalMs = 60 * 60_000,
}) {
  // In-memory only: a restart simply retries failed shops sooner.
  const reconcileRetryAt = new Map();
  const behindReportedAt = new Map();
  let stopping = false;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A loop that waits longer than the heartbeat's staleness limit names itself
  // so it keeps reporting in while idle.
  async function pauseUnlessStopping(ms, heartbeat) {
    for (let waited = 0; waited < ms && !stopping; waited += pollMs) {
      if (heartbeat) workerHeartbeat(heartbeat);
      await pause(Math.min(pollMs, ms - waited));
    }
  }

  async function reconcileShop(shop) {
    const started = Date.now();
    try {
      const { admin } = await adminForShop(shop.shopDomain);
      const result = await reconcile({ admin, shopDomain: shop.shopDomain, database,
        onProgress: () => workerHeartbeat("reconciliation") });
      reconcileRetryAt.delete(shop.id);
      logEvent("reconciliation_completed", { shopId: shop.id, pages: result.pages,
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
      select: { id: true, shopDomain: true, orderReconciliationSince: true, orderReconciliationCursor: true },
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
      let worked = false;
      try {
        worked = await reconciliationPass();
      } catch (error) {
        reportFailure("worker_loop_failed", error, { loop: "reconciliation" });
      }
      if (!worked) await pauseUnlessStopping(reconcileIdleMs);
    }
  }

  // Hourly: billing charges at most once a day per agreement, and Shopify
  // retries are spaced by each charge's own backoff.
  async function billingLoop() {
    while (!stopping) {
      workerHeartbeat("billing");
      try {
        const result = await billingPass({ database, adminForShop, onProgress: () => workerHeartbeat("billing") });
        logEvent("billing_pass_completed", result);
      } catch (error) {
        reportFailure("worker_loop_failed", error, { loop: "billing" });
      }
      await pauseUnlessStopping(billingIntervalMs, "billing");
    }
  }

  async function run() {
    logEvent("worker_started", { concurrency });
    expectWorkerLoops(["reconciliation", "billing", ...Array.from({ length: concurrency }, (_, id) => `delivery-${id}`)]);
    try {
      await Promise.all([
        ...Array.from({ length: concurrency }, (_, id) => deliveryLoop(id)),
        reconciliationLoop(),
        billingLoop(),
      ]);
    } finally {
      await database.$disconnect();
      logEvent("worker_stopped");
    }
  }

  return { run, stop: () => { stopping = true; }, reconciliationPass };
}
