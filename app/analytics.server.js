import prisma from "./db.server";
import { adminGraphql } from "./order-shopify.server";
import { aggregateAnalytics, analyticsRange } from "./analytics";

const SHOP_QUERY = `#graphql
  query AnalyticsShop { shop { currencyCode ianaTimezone } }
`;

export async function readAnalytics({ admin, shopDomain, search, database = prisma }) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  const data = await adminGraphql(admin, SHOP_QUERY);
  const { currencyCode, ianaTimezone } = data.shop;
  const range = analyticsRange(search, ianaTimezone);
  const includeTest = search.get("test") === "1";
  const [orders, refunds] = await Promise.all([
    database.order.findMany({ where: { shopId: shop.id }, select: {
      firstPaidAt: true, paidEligible: true,
      currencyCode: true, isTest: true, financialStatus: true,
      protectionPurchase: { select: { purchasedAt: true, feeAmount: true, currencyCode: true } },
    } }),
    database.protectionRefund.findMany({ where: { shopId: shop.id }, select: {
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
    },
  };
}
