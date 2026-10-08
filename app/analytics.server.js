import prisma from "./db.server";
import { adminGraphql } from "./order-shopify.server";
import { aggregateAnalytics, analyticsRange, dailyTrend } from "./analytics";
import { logEvent } from "./observability.server";
import { retentionCutoff } from "./order-retention";

// The worker reconciles every shop about every 10 minutes, so an older last
// sync means it is down or falling behind. Single orders that fail to store
// are an operator problem (Sentry: webhook_terminal), not a merchant warning.
const SYNC_STALE_MS = 60 * 60_000;

const SHOP_QUERY = `#graphql
  query AnalyticsShop { shop { currencyCode ianaTimezone } }
`;

function databaseRange(range) {
  // Read a two-day UTC envelope, then apply the exact merchant calendar range
  // in aggregateAnalytics. This covers all supported time zone offsets.
  const start = range.start ? new Date(Date.parse(`${range.start}T00:00:00Z`) - 86400000) : undefined;
  const end = new Date(Date.parse(`${range.end}T00:00:00Z`) + 2 * 86400000);
  return { ...(start ? { gte: start } : {}), lt: end };
}

export async function readAnalytics({ admin, shopDomain, search, database = prisma, now = new Date() }) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  return readShopAnalytics({ admin, shopDomain, shop, search, database, now });
}

async function readShopAnalytics({ admin, shopDomain, shop, search, database, now }) {
  const data = await adminGraphql(admin, SHOP_QUERY, {}, { shop: shopDomain });
  const { currencyCode, ianaTimezone } = data.shop;
  const range = analyticsRange(search, ianaTimezone, now);
  const includeTest = search.get("test") === "1";
  const dateFilter = databaseRange(range);
  const syncedAt = shop.orderReconciliationSince;
  const [orders, refunds] = await Promise.all([
    database.order.findMany({ where: { shopId: shop.id, OR: [
      { firstPaidAt: dateFilter },
      { firstPaidAt: null, shopifyCreatedAt: dateFilter, financialStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
    ] }, select: {
      firstPaidAt: true, paidEligible: true,
      currencyCode: true, isTest: true, financialStatus: true,
      protectionPurchase: { select: { purchasedAt: true, feeAmount: true,
        coveredMerchandiseAmount: true, currencyCode: true, pricingCheck: true } },
    } }),
    database.protectionRefund.findMany({ where: { shopId: shop.id,
      ...(!includeTest ? { order: { isTest: false } } : {}),
      OR: [{ succeededAt: dateFilter }, { status: { in: ["PENDING", "UNATTRIBUTED"] }, createdAt: dateFilter }],
    }, select: {
      status: true, amount: true, currencyCode: true, succeededAt: true,
      order: { select: { isTest: true } },
    } }),
  ]);
  return {
    ...aggregateAnalytics({ orders, refunds, timeZone: ianaTimezone, currencyCode, range, includeTest }),
    currencyCode, timeZone: ianaTimezone, range, includeTest,
    rowCounts: { orders: orders.length, refunds: refunds.length },
    sync: {
      complete: Boolean(shop.orderReconciliationSince) && !shop.orderReconciliationCursor,
      behind: Boolean(syncedAt) && now.getTime() - syncedAt.getTime() > SYNC_STALE_MS,
      cursor: Boolean(shop.orderReconciliationCursor),
      reconciledThrough: shop.orderReconciliationSince?.toISOString() ?? null,
      // Before the first backfill or the retention cutoff, orders are missing
      // locally, so totals for those dates are incomplete.
      historyLimited: !shop.orderHistoryStartAt || !shop.orderReconciliationSince || !range.start ||
        range.start < shop.orderHistoryStartAt.toISOString().slice(0, 10) ||
        range.start < retentionCutoff(now).toISOString().slice(0, 10),
    },
  };
}

const RECENT_ACTIVITY_LIMIT = 5;

async function readRecentActivity({ shopId, includeTest, database }) {
  const orderScope = includeTest ? {} : { order: { isTest: false } };
  const orderFields = { select: { name: true, shopifyOrderId: true } };
  const [purchases, refunds] = await Promise.all([
    database.protectionPurchase.findMany({
      where: { shopId, purchasedAt: { not: null }, ...orderScope },
      orderBy: { purchasedAt: "desc" }, take: RECENT_ACTIVITY_LIMIT,
      select: { id: true, purchasedAt: true, feeAmount: true, currencyCode: true, order: orderFields },
    }),
    database.protectionRefund.findMany({
      where: { shopId, status: "CONFIRMED", succeededAt: { not: null }, ...orderScope },
      orderBy: { succeededAt: "desc" }, take: RECENT_ACTIVITY_LIMIT,
      select: { id: true, succeededAt: true, amount: true, currencyCode: true, order: orderFields },
    }),
  ]);
  return [
    ...purchases.map((purchase) => ({
      id: `purchase-${purchase.id}`, kind: "PURCHASED", at: purchase.purchasedAt.toISOString(),
      amount: String(purchase.feeAmount), currencyCode: purchase.currencyCode,
      orderName: purchase.order.name, shopifyOrderId: purchase.order.shopifyOrderId,
    })),
    ...refunds.map((refund) => ({
      id: `refund-${refund.id}`, kind: "REFUNDED", at: refund.succeededAt.toISOString(),
      amount: String(refund.amount), currencyCode: refund.currencyCode,
      orderName: refund.order.name, shopifyOrderId: refund.order.shopifyOrderId,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_ACTIVITY_LIMIT);
}

// The Overview is a fixed 30-day dashboard; deeper reporting (custom ranges,
// breakdowns, exports) is intentionally out of scope for the MVP.
export async function readOverview({ admin, shopDomain, includeTest = false, database = prisma, now = new Date() }) {
  const started = Date.now();
  const search = new URLSearchParams({ range: "30", ...(includeTest ? { test: "1" } : {}) });
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  const [analytics, recentActivity] = await Promise.all([
    readShopAnalytics({ admin, shopDomain, shop, search, database, now }),
    readRecentActivity({ shopId: shop.id, includeTest, database }),
  ]);
  const overview = {
    ...analytics,
    trend: dailyTrend(analytics.trend, analytics.range),
    recentActivity,
  };
  // The Overview aggregates in memory; this shows when it needs SQL aggregates.
  logEvent("overview_loaded", { shopId: shop.id, orderRows: analytics.rowCounts.orders,
    refundRows: analytics.rowCounts.refunds, durationMs: Date.now() - started });
  return overview;
}
