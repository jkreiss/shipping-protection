import process from "node:process";
import prisma from "../app/db.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { processNextDelivery, workerConcurrency } from "../app/webhook-worker.server.js";
import { reconcileOrders } from "../app/order-reconciliation.server.js";
import { logEvent, reportFailure } from "../app/observability.server.js";

const pollMs = 2_000;
const reconcileEveryMs = 15 * 60_000;
const concurrency = workerConcurrency(process.env.WORKER_CONCURRENCY);
let stopping = false;
let lastShopId = "";

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reconcileOneShop() {
  const shop = await prisma.shop.findFirst({
    where: { installationState: "INSTALLED", id: { gt: lastShopId } },
    orderBy: { id: "asc" }, select: { id: true, shopDomain: true },
  }) ?? await prisma.shop.findFirst({
    where: { installationState: "INSTALLED" },
    orderBy: { id: "asc" }, select: { id: true, shopDomain: true },
  });
  if (!shop) return;
  lastShopId = shop.id;
  const started = Date.now();
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    const result = await reconcileOrders({ admin, shopDomain: shop.shopDomain, maxPages: 1, pageSize: 10 });
    logEvent("reconciliation_completed", { shopId: shop.id, ordersProcessed: result.ordersProcessed,
      complete: result.complete, durationMs: Date.now() - started });
  } catch (error) {
    reportFailure("reconciliation_failed", error, { shopId: shop.id, durationMs: Date.now() - started });
  }
}

// Each loop claims one order's queued deliveries at a time; an empty queue
// makes it wait before polling again. A loop finishes its current batch on SIGTERM.
async function deliveryLoop() {
  while (!stopping) {
    try {
      if (await processNextDelivery()) continue;
    } catch (error) {
      reportFailure("worker_loop_failed", error);
    }
    if (!stopping) await pause(pollMs);
  }
}

async function reconciliationLoop() {
  let nextReconcileAt = 0;
  while (!stopping) {
    if (Date.now() >= nextReconcileAt) {
      nextReconcileAt = Date.now() + reconcileEveryMs;
      try {
        await reconcileOneShop();
      } catch (error) {
        reportFailure("worker_loop_failed", error);
      }
    }
    if (!stopping) await pause(pollMs);
  }
}

logEvent("worker_started", { concurrency });
await Promise.all([
  ...Array.from({ length: concurrency }, () => deliveryLoop()),
  reconciliationLoop(),
]);
await prisma.$disconnect();
logEvent("worker_stopped");
