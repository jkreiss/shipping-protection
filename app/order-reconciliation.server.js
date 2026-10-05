import prisma from "./db.server.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { persistNormalizedOrder } from "./order-ingestion.server.js";
import { adminGraphql, assertCompleteOrder, fetchShopifyOrder, ORDERS_QUERY } from "./order-shopify.server.js";
import { retrySerializationFailures } from "./serializable-retry.server.js";
import { queueOrderRefresh } from "./webhook-inbox.server.js";
import { reportFailure } from "./observability.server.js";

const BACKFILL_MS = 60 * 86400000;
// Each window starts this far before the last one ended, to catch orders
// Shopify's search index hadn't picked up yet. Unchanged orders are skipped,
// so the overlap costs only the listing.
export const RECONCILIATION_OVERLAP_MS = 10 * 60_000;
export const RECONCILIATION_INTERVAL_MS = 10 * 60_000;
// Alert earlier than the merchant-facing banner, which waits an hour.
export const SYNC_BEHIND_MS = 30 * 60_000;
export const SYNC_BEHIND_REPORT_EVERY_MS = 10 * 60_000;
const DEFAULT_TIME_BUDGET_MS = 60_000;
// This many failed orders in a row means Shopify or the database is down, not
// that the orders are bad: stop and retry the page rather than queue them all.
export const MAX_CONSECUTIVE_ORDER_FAILURES = 3;
const PENDING_REFUND_RECHECKS = 20;

function searchWindow(since, until) {
  return `updated_at:>='${since.toISOString()}' updated_at:<='${until.toISOString()}'`;
}

// A shop needs work while it is backfilling or part way through a window, and
// otherwise once every interval after its last window ended.
export function reconciliationDue(shop, now = new Date()) {
  if (!shop.orderReconciliationSince || shop.orderReconciliationCursor) return true;
  return now.getTime() - shop.orderReconciliationSince.getTime() >= RECONCILIATION_INTERVAL_MS;
}

// Whole minutes since the shop's last completed sync window, once that is past
// the alert threshold; null while the shop is current or has no window yet.
export function syncBehindMinutes(shop, now = new Date()) {
  if (!shop.orderReconciliationSince) return null;
  const behindMs = now.getTime() - shop.orderReconciliationSince.getTime();
  return behindMs > SYNC_BEHIND_MS ? Math.floor(behindMs / 60_000) : null;
}

// Shops to report now. reportedAt (shop id -> time) holds the last report so a
// long outage raises one alert every few minutes, not one per pass.
export function shopsToReportBehind(shops, reportedAt, now = new Date()) {
  const due = [];
  for (const shop of shops) {
    const minutes = syncBehindMinutes(shop, now);
    if (minutes === null) {
      reportedAt.delete(shop.id);
      continue;
    }
    if (now.getTime() - (reportedAt.get(shop.id) ?? 0) < SYNC_BEHIND_REPORT_EVERY_MS) continue;
    reportedAt.set(shop.id, now.getTime());
    due.push({ shopId: shop.id, minutesBehind: minutes });
  }
  return due;
}

async function storeOrder(database, persist, shop, order) {
  const normalized = normalizeGraphqlOrder(assertCompleteOrder(order));
  await retrySerializationFailures(() => database.$transaction(
    (transaction) => persist(transaction, shop, normalized),
    { isolationLevel: "Serializable", timeout: 20_000 },
  ));
  return normalized;
}

// onProgress runs after each listing page, order, and refund recheck, so the
// worker can show a long turn is still moving (the time budget is only checked
// between pages).
export async function reconcileOrders({
  admin,
  shopDomain,
  pageSize = 250,
  database = prisma,
  maxPages = 1000,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS,
  persist = persistNormalizedOrder,
  onProgress,
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
  let ordersFailed = 0;
  let newestUpdatedAt = since;
  let hasNextPage = true;
  let consecutiveFailures = 0;

  while (hasNextPage && pages < maxPages && (pages === 0 || Date.now() - started < timeBudgetMs)) {
    const data = await adminGraphql(admin, ORDERS_QUERY, {
      first: pageSize,
      after,
      query: searchWindow(since, until),
    }, options);
    onProgress?.();
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
      // One order that can't be stored must not hold back the rest of the
      // shop: hand it to the worker's retries and keep the window moving.
      try {
        const order = await fetchShopifyOrder(admin, item.id, options);
        const normalized = await storeOrder(database, persist, shop, order);
        if (normalized.shopifyUpdatedAt > newestUpdatedAt) newestUpdatedAt = normalized.shopifyUpdatedAt;
        ordersFetched += 1;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        reportFailure("reconciliation_order_failed", error, { shopId: shop.id, shopifyOrderId: item.id });
        if (consecutiveFailures >= MAX_CONSECUTIVE_ORDER_FAILURES) throw error;
        await queueOrderRefresh({ shopId: shop.id, shopifyOrderId: item.id, version: item.updatedAt, database });
        ordersFailed += 1;
      } finally {
        onProgress?.();
      }
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

  // Recheck refunds still waiting on a transaction, least recently checked
  // first; storing the order again bumps updatedAt, so the next turn moves on.
  // UNATTRIBUTED refunds only change when the order does, which a webhook
  // reports, so they are not polled.
  const pending = await database.protectionRefund.findMany({
    where: {
      shopId: shop.id, status: "PENDING",
      updatedAt: { lt: new Date(Date.now() - RECONCILIATION_INTERVAL_MS) },
    },
    orderBy: { updatedAt: "asc" },
    select: { orderId: true, order: { select: { shopifyOrderId: true } } },
    distinct: ["orderId"],
    take: PENDING_REFUND_RECHECKS,
  });
  for (const entry of pending) {
    try {
      const order = await fetchShopifyOrder(admin, entry.order.shopifyOrderId, options);
      await storeOrder(database, persist, shop, order);
    } catch (error) {
      reportFailure("refund_recheck_failed", error, { shopId: shop.id, shopifyOrderId: entry.order.shopifyOrderId });
      // Move it to the back of the queue so one bad order can't hold the front.
      await database.protectionRefund.updateMany({
        where: { shopId: shop.id, orderId: { equals: entry.orderId }, status: "PENDING" },
        data: { updatedAt: new Date() },
      });
    } finally {
      onProgress?.();
    }
  }

  return {
    pages,
    ordersListed,
    ordersFetched,
    ordersFailed,
    ordersSkipped: ordersListed - ordersFetched - ordersFailed,
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
