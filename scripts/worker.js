import process from "node:process";
import prisma from "../app/db.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { processNextDelivery } from "../app/webhook-worker.server.js";
import { reconcileOrders } from "../app/order-reconciliation.server.js";
import { logEvent, reportFailure } from "../app/observability.server.js";

const pollMs = 2_000;
const reconcileEveryMs = 15 * 60_000;
let stopping = false;
let nextReconcileAt = 0;
let lastShopId = "";

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

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

logEvent("worker_started");
while (!stopping) {
  try {
    const processed = await processNextDelivery();
    if (processed) continue;
    if (Date.now() >= nextReconcileAt) {
      nextReconcileAt = Date.now() + reconcileEveryMs;
      await reconcileOneShop();
    }
  } catch (error) {
    reportFailure("worker_loop_failed", error);
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
await prisma.$disconnect();
logEvent("worker_stopped");
