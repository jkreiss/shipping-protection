import process from "node:process";
import prisma from "../app/db.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { processNextDelivery, workerConcurrency } from "../app/webhook-worker.server.js";
import { reconcileOrders, reconciliationDue, shopsToReportBehind } from "../app/order-reconciliation.server.js";
import { expectWorkerLoops, logEvent, reportCondition, reportFailure, workerHeartbeat } from "../app/observability.server.js";

const pollMs = 2_000;
const reconcileIdleMs = 30_000;
const reconcileFailureBackoffMs = 5 * 60_000;
// In-memory only: a restart simply retries failed shops sooner.
const reconcileRetryAt = new Map();
const behindReportedAt = new Map();
const concurrency = workerConcurrency(process.env.WORKER_CONCURRENCY);
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pauseUnlessStopping(ms) {
  for (let waited = 0; waited < ms && !stopping; waited += pollMs) await pause(Math.min(pollMs, ms - waited));
}

async function reconcileShop(shop) {
  const started = Date.now();
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const result = await reconcileOrders({ admin, shopDomain: shop.shopDomain,
      onProgress: () => workerHeartbeat("reconciliation") });
    reconcileRetryAt.delete(shop.id);
    logEvent("reconciliation_completed", { shopId: shop.id, pages: result.pages,
      ordersListed: result.ordersListed, ordersFetched: result.ordersFetched, ordersFailed: result.ordersFailed, ordersSkipped: result.ordersSkipped,
      complete: result.complete, windowEnd: result.windowEnd, durationMs: Date.now() - started });
  } catch (error) {
    // Back off so a shop that keeps failing isn't retried in a tight loop.
    reconcileRetryAt.set(shop.id, Date.now() + reconcileFailureBackoffMs);
    reportFailure("reconciliation_failed", error, { shopId: shop.id, durationMs: Date.now() - started });
  }
}

// One pass over installed shops, working on each shop that is due. A shop
// still backfilling gets one time-boxed turn per pass, so other shops keep up.
async function reconciliationPass() {
  const shops = await prisma.shop.findMany({
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
// makes it wait before polling again. A loop finishes its current batch on SIGTERM.
async function deliveryLoop(id) {
  while (!stopping) {
    workerHeartbeat(`delivery-${id}`);
    try {
      if (await processNextDelivery()) continue;
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

logEvent("worker_started", { concurrency });
expectWorkerLoops(["reconciliation", ...Array.from({ length: concurrency }, (_, id) => `delivery-${id}`)]);
await Promise.all([
  ...Array.from({ length: concurrency }, (_, id) => deliveryLoop(id)),
  reconciliationLoop(),
]);
await prisma.$disconnect();
logEvent("worker_stopped");
