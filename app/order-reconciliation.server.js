import prisma from "./db.server.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { persistNormalizedOrder } from "./order-ingestion.server.js";
import { adminGraphql, assertCompleteOrder, fetchShopifyOrder, ORDERS_QUERY } from "./order-shopify.server.js";

function searchWindow(since, until) {
  return `updated_at:>='${since.toISOString()}' updated_at:<='${until.toISOString()}'`;
}

export async function reconcileOrders({
  admin,
  shopDomain,
  pageSize = 10,
  hashSecret = process.env.CHECKOUT_TOKEN_HASH_SECRET,
  database = prisma,
  maxPages = 20,
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) {
    throw new RangeError("Reconciliation page size must be from 1 to 250.");
  }
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");

  const since = shop.orderReconciliationSince ?? new Date(Date.now() - 60 * 86400000);
  const until = shop.orderReconciliationUntil ?? new Date();
  let after = shop.orderReconciliationUntil ? shop.orderReconciliationCursor : null;
  let pages = 0;
  let ordersProcessed = 0;
  let newestUpdatedAt = since;
  let hasNextPage = true;

  while (hasNextPage && pages < maxPages) {
    const data = await adminGraphql(admin, ORDERS_QUERY, {
      first: pageSize,
      after,
      query: searchWindow(since, until),
    }, { shop: shopDomain });
    const connection = data.orders;
    const fullOrders = [];
    for (const item of connection.nodes) {
      fullOrders.push(await fetchShopifyOrder(admin, item.id, { shop: shopDomain }));
    }
    await database.$transaction(async (transaction) => {
      for (const order of fullOrders) {
        const normalized = normalizeGraphqlOrder(assertCompleteOrder(order), hashSecret);
        await persistNormalizedOrder(transaction, shop, normalized);
        if (normalized.shopifyUpdatedAt > newestUpdatedAt) {
          newestUpdatedAt = normalized.shopifyUpdatedAt;
        }
        ordersProcessed += 1;
      }
      await transaction.shop.update({
        where: { id: shop.id },
        data: connection.pageInfo.hasNextPage
          ? { orderReconciliationCursor: connection.pageInfo.endCursor, orderReconciliationUntil: until,
              ...(shop.orderHistoryStartAt ? {} : { orderHistoryStartAt: since }) }
          : {
              orderReconciliationSince: until,
              orderReconciliationCursor: null,
              orderReconciliationUntil: null,
              ...(shop.orderHistoryStartAt ? {} : { orderHistoryStartAt: since }),
            },
      });
    }, { isolationLevel: "Serializable", timeout: 20_000 });
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
    const order = await fetchShopifyOrder(admin, entry.order.shopifyOrderId, { shop: shopDomain });
    await database.$transaction(
      (transaction) => persistNormalizedOrder(transaction, shop, normalizeGraphqlOrder(order, hashSecret)),
      { isolationLevel: "Serializable", timeout: 20_000 },
    );
  }

  return {
    pages,
    ordersProcessed,
    pendingRechecked: pending.length,
    complete: !hasNextPage,
    resumeCursor: hasNextPage ? after : null,
    reconciledThrough: newestUpdatedAt.toISOString(),
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
  };
}
