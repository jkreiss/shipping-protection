import prisma from "./db.server";
import { adminGraphql } from "./order-shopify.server";
import { aggregateAnalytics, analyticsRange } from "./analytics";

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

export async function readAnalytics({ admin, shopDomain, search, database = prisma }) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  const data = await adminGraphql(admin, SHOP_QUERY);
  const { currencyCode, ianaTimezone } = data.shop;
  const range = analyticsRange(search, ianaTimezone);
  const includeTest = search.get("test") === "1";
  const dateFilter = databaseRange(range);
  const [orders, refunds] = await Promise.all([
    database.order.findMany({ where: { shopId: shop.id, OR: [
      { firstPaidAt: dateFilter },
      { firstPaidAt: null, shopifyCreatedAt: dateFilter, financialStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
    ] }, select: {
      firstPaidAt: true, paidEligible: true,
      currencyCode: true, isTest: true, financialStatus: true,
      protectionPurchase: { select: { purchasedAt: true, feeAmount: true,
        coveredMerchandiseAmount: true, currencyCode: true } },
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
    sync: {
      complete: Boolean(shop.orderReconciliationSince) && !shop.orderReconciliationCursor,
      cursor: Boolean(shop.orderReconciliationCursor),
      reconciledThrough: shop.orderReconciliationSince?.toISOString() ?? null,
      historyLimited: !shop.orderHistoryStartAt || !shop.orderReconciliationSince ||
        !range.start || range.start < shop.orderHistoryStartAt.toISOString().slice(0, 10),
    },
  };
}
