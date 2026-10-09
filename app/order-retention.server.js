import prisma from "./db.server.js";
import { retentionCutoff } from "./order-retention.js";
import { deleteOrderRecords } from "./shop.server.js";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const RETENTION_BATCH_SIZE = 500;
// One purge turn is time-boxed so reconciliation keeps running during a backlog.
export const RETENTION_BUDGET_MS = 60_000;
// Prisma's default 5-second interactive transaction is too short for a full
// batch on a busy database.
export const RETENTION_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };
const FINISHED_DELIVERY = { in: ["PROCESSED", "FAILED"] };

export async function shopsWithExpiredOrders(database, cutoff, skipShopIds = []) {
  const shops = await database.shop.findMany({
    where: { id: { notIn: [...skipShopIds] }, orders: { some: { shopifyCreatedAt: { lt: cutoff } } } },
    orderBy: { id: "asc" }, select: { id: true },
  });
  return shops.map(({ id }) => id);
}

// Deletes up to batchSize of one shop's orders placed before the cutoff, with
// their lines, purchases, refunds, claims, and webhook deliveries. selected is
// what the batch found (fewer than batchSize means the shop is done); deleted
// can be lower when a customer redaction removed some first.
export async function purgeExpiredShopBatch(transaction, shopId, cutoff, batchSize = RETENTION_BATCH_SIZE) {
  const orders = await transaction.order.findMany({
    where: { shopId, shopifyCreatedAt: { lt: cutoff } },
    orderBy: [{ shopifyCreatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, shopifyOrderId: true },
  });
  if (orders.length === 0) return { selected: 0, deleted: 0 };
  const deleted = await deleteOrderRecords(transaction, shopId,
    orders.map((order) => order.id), orders.map((order) => order.shopifyOrderId));
  return { selected: orders.length, deleted };
}

// Finished deliveries received before the cutoff, even when their order was
// never stored. Deleting by id keeps each statement small.
export async function purgeExpiredDeliveryBatch(database, cutoff, batchSize = RETENTION_BATCH_SIZE) {
  const rows = await database.webhookDelivery.findMany({
    where: { receivedAt: { lt: cutoff }, status: FINISHED_DELIVERY }, select: { id: true }, take: batchSize,
  });
  if (rows.length === 0) return { selected: 0, deleted: 0 };
  const { count } = await database.webhookDelivery.deleteMany({
    where: { id: { in: rows.map(({ id }) => id) }, status: FINISHED_DELIVERY },
  });
  return { selected: rows.length, deleted: count };
}

// Purges shop by shop in short transactions, so a backlog never holds long
// locks and one shop that keeps failing can't hold back the rest: its error
// goes to onShopFailure and the run moves on. Stops when the budget runs out
// or the worker stops; complete is false then, and the next turn continues
// (pass the failed shops back as skipShopIds). Once every shop is done, old
// finished deliveries go too. onProgress runs after each batch so the worker
// stays visibly alive.
export async function purgeExpiredOrders({
  database = prisma,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  budgetMs = RETENTION_BUDGET_MS,
  shouldStop = () => false,
  onProgress = () => {},
  onShopFailure = () => {},
  skipShopIds = [],
  clock = Date.now,
} = {}) {
  const cutoff = retentionCutoff(now);
  const deadline = clock() + budgetMs;
  const outOfTurn = () => shouldStop() || clock() >= deadline;
  const failedShopIds = [];
  let ordersDeleted = 0;
  let deliveriesDeleted = 0;
  const finish = (complete) => ({ cutoff, ordersDeleted, deliveriesDeleted, failedShopIds, complete });

  for (const shopId of await shopsWithExpiredOrders(database, cutoff, skipShopIds)) {
    try {
      for (;;) {
        if (outOfTurn()) return finish(false);
        const { selected, deleted } = await database.$transaction(
          (transaction) => purgeExpiredShopBatch(transaction, shopId, cutoff, batchSize),
          RETENTION_TRANSACTION_OPTIONS,
        );
        ordersDeleted += deleted;
        onProgress();
        if (selected < batchSize) break;
      }
    } catch (error) {
      failedShopIds.push(shopId);
      onShopFailure(shopId, error);
    }
  }
  for (;;) {
    if (outOfTurn()) return finish(false);
    const { selected, deleted } = await purgeExpiredDeliveryBatch(database, cutoff, batchSize);
    deliveriesDeleted += deleted;
    if (selected === 0) break;
    onProgress();
    if (selected < batchSize) break;
  }
  return finish(true);
}
