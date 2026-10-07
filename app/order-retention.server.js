import prisma from "./db.server.js";
import { retentionCutoff } from "./order-retention.js";
import { deleteOrderRecords } from "./shop.server.js";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const RETENTION_BATCH_SIZE = 500;
// One purge turn is time-boxed so reconciliation keeps running during a backlog.
export const RETENTION_BUDGET_MS = 60_000;

// Deletes up to batchSize orders placed before the cutoff, all from the shop
// holding the oldest one, with their lines, purchases, refunds, claims, and
// webhook deliveries. One shop per batch keeps each transaction to a fixed
// handful of statements. Returns the number of orders deleted.
export async function purgeExpiredOrderBatch(transaction, cutoff, batchSize = RETENTION_BATCH_SIZE) {
  const oldest = await transaction.order.findFirst({
    where: { shopifyCreatedAt: { lt: cutoff } },
    orderBy: [{ shopifyCreatedAt: "asc" }, { id: "asc" }],
    select: { shopId: true },
  });
  if (!oldest) return 0;
  const orders = await transaction.order.findMany({
    where: { shopId: oldest.shopId, shopifyCreatedAt: { lt: cutoff } },
    orderBy: [{ shopifyCreatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, shopifyOrderId: true },
  });
  await deleteOrderRecords(transaction, oldest.shopId,
    orders.map((order) => order.id), orders.map((order) => order.shopifyOrderId));
  return orders.length;
}

// Purges in short transactions so a backlog never holds long locks, stopping
// when the budget runs out or the worker stops; complete is false then, and the
// next turn continues. Once complete, finished webhook deliveries past the
// cutoff go too, even when their order was never stored. onProgress runs after
// each batch so the worker stays visibly alive.
export async function purgeExpiredOrders({
  database = prisma,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  budgetMs = RETENTION_BUDGET_MS,
  shouldStop = () => false,
  onProgress = () => {},
  clock = Date.now,
} = {}) {
  const cutoff = retentionCutoff(now);
  const deadline = clock() + budgetMs;
  let ordersDeleted = 0;
  let complete = false;
  while (!shouldStop() && clock() < deadline) {
    const deleted = await database.$transaction((transaction) => purgeExpiredOrderBatch(transaction, cutoff, batchSize));
    ordersDeleted += deleted;
    onProgress();
    if (deleted === 0) {
      complete = true;
      break;
    }
  }
  if (!complete) return { cutoff, ordersDeleted, deliveriesDeleted: 0, complete };
  const { count: deliveriesDeleted } = await database.webhookDelivery.deleteMany({
    where: { receivedAt: { lt: cutoff }, status: { in: ["PROCESSED", "FAILED"] } },
  });
  return { cutoff, ordersDeleted, deliveriesDeleted, complete };
}
