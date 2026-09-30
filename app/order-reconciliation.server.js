import prisma from "./db.server.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { persistNormalizedOrder } from "./order-ingestion.server.js";
import { adminGraphql, assertCompleteOrder, fetchShopifyOrder, ORDERS_QUERY } from "./order-shopify.server.js";
import { retrySerializationFailures } from "./serializable-retry.server.js";

const BACKFILL_MS = 60 * 86400000;
// Each window starts this far before the last one ended, to catch orders
// Shopify's search index hadn't picked up yet. Unchanged orders are skipped,
// so the overlap costs only the listing.
export const RECONCILIATION_OVERLAP_MS = 10 * 60_000;
export const RECONCILIATION_INTERVAL_MS = 10 * 60_000;
const DEFAULT_TIME_BUDGET_MS = 60_000;

function searchWindow(since, until) {
  return `updated_at:>='${since.toISOString()}' updated_at:<='${until.toISOString()}'`;
}

// A shop needs work while it is backfilling or part way through a window, and
// otherwise once every interval after its last window ended.
export function reconciliationDue(shop, now = new Date()) {
  if (!shop.orderReconciliationSince || shop.orderReconciliationCursor) return true;
  return now.getTime() - shop.orderReconciliationSince.getTime() >= RECONCILIATION_INTERVAL_MS;
}

async function storeOrder(database, persist, shop, order, hashSecret) {
  const normalized = normalizeGraphqlOrder(assertCompleteOrder(order), hashSecret);
  await retrySerializationFailures(() => database.$transaction(
    (transaction) => persist(transaction, shop, normalized),
    { isolationLevel: "Serializable", timeout: 20_000 },
  ));
  return normalized;
}

export async function reconcileOrders({
  admin,
  shopDomain,
  pageSize = 250,
  hashSecret = process.env.CHECKOUT_TOKEN_HASH_SECRET,
  database = prisma,
  maxPages = 1000,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  persist = persistNormalizedOrder,
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) {
    throw new RangeError("Reconciliation page size must be from 1 to 250.");
  }
  const started = Date.now();
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  const options = { shop: shopDomain };

  // A window in progress keeps its bounds until its last page is stored.
  const since = shop.orderReconciliationSince
    ? new Date(shop.orderReconciliationSince.getTime() - RECONCILIATION_OVERLAP_MS)
    : new Date(Date.now() - BACKFILL_MS);
  const until = shop.orderReconciliationUntil ?? new Date();
  let after = shop.orderReconciliationUntil ? shop.orderReconciliationCursor : null;
  const historyStart = shop.orderHistoryStartAt ? {} : { orderHistoryStartAt: since };
  let pages = 0;
  let ordersListed = 0;
  let ordersFetched = 0;
  let newestUpdatedAt = since;
  let hasNextPage = true;

  while (hasNextPage && pages < maxPages && (pages === 0 || Date.now() - started < timeBudgetMs)) {
    const data = await adminGraphql(admin, ORDERS_QUERY, {
      first: pageSize,
      after,
      query: searchWindow(since, until),
    }, options);
    const connection = data.orders;
    const listed = connection.nodes;
    const local = listed.length ? await database.order.findMany({
      where: { shopId: shop.id, shopifyOrderId: { in: listed.map(({ id }) => id) } },
      select: { shopifyOrderId: true, shopifyUpdatedAt: true },
    }) : [];
    const storedAt = new Map(local.map((order) => [order.shopifyOrderId, order.shopifyUpdatedAt.getTime()]));
    for (const item of listed) {
      const shopifyUpdatedAt = Date.parse(item.updatedAt);
      // Webhooks usually stored the order already; fetch only what's missing or newer.
      if (storedAt.has(item.id) && storedAt.get(item.id) >= shopifyUpdatedAt) continue;
      const order = await fetchShopifyOrder(admin, item.id, options);
      const normalized = await storeOrder(database, persist, shop, order, hashSecret);
      if (normalized.shopifyUpdatedAt > newestUpdatedAt) newestUpdatedAt = normalized.shopifyUpdatedAt;
      ordersFetched += 1;
    }
    ordersListed += listed.length;
    await database.shop.update({
      where: { id: shop.id },
      data: connection.pageInfo.hasNextPage
        ? { orderReconciliationCursor: connection.pageInfo.endCursor, orderReconciliationUntil: until, ...historyStart }
        : {
            orderReconciliationSince: until,
            orderReconciliationCursor: null,
            orderReconciliationUntil: null,
            ...historyStart,
          },
    });
    after = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
    pages += 1;
  }

  const pending = await database.protectionRefund.findMany({
    where: { shopId: shop.id, status: { in: ["PENDING", "UNATTRIBUTED"] } },
    select: { order: { select: { shopifyOrderId: true } } },
    distinct: ["orderId"],
    take: 20,
  });
  for (const entry of pending) {
    const order = await fetchShopifyOrder(admin, entry.order.shopifyOrderId, options);
    await storeOrder(database, persist, shop, order, hashSecret);
  }

  return {
    pages,
    ordersListed,
    ordersFetched,
    ordersSkipped: ordersListed - ordersFetched,
    ordersProcessed: ordersFetched,
    pendingRechecked: pending.length,
    complete: !hasNextPage,
    resumeCursor: hasNextPage ? after : null,
    reconciledThrough: newestUpdatedAt.toISOString(),
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    durationMs: Date.now() - started,
  };
}
