import { describe, expect, test, vi } from "vitest";
import { readAnalytics, readOverview } from "./analytics.server.js";

describe("analytics database scope", () => {
  test("bounds merchant queries by shop and the selected date range", async () => {
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({
        id: "shop-1", orderHistoryStartAt: new Date("2026-09-01T00:00:00Z"),
        orderReconciliationSince: new Date("2026-09-30T00:00:00Z"), orderReconciliationCursor: null,
      }) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      shop: { currencyCode: "AUD", ianaTimezone: "Australia/Sydney" },
    } }) }) };
    const result = await readAnalytics({ admin, shopDomain: "one.myshopify.com",
      search: new URLSearchParams("range=custom&start=2026-09-10&end=2026-09-12"), database });
    const orderWhere = database.order.findMany.mock.calls[0][0].where;
    const refundWhere = database.protectionRefund.findMany.mock.calls[0][0].where;
    expect(orderWhere.shopId).toBe("shop-1");
    expect(orderWhere.OR[0].firstPaidAt).toEqual({
      gte: new Date("2026-09-09T00:00:00Z"), lt: new Date("2026-09-14T00:00:00Z"),
    });
    expect(refundWhere.shopId).toBe("shop-1");
    expect(result.sync.historyLimited).toBe(false);
  });

  test("overview reads a fixed 30-day window and tenant-scoped recent activity", async () => {
    const order = { name: "#1001", shopifyOrderId: "gid://shopify/Order/1" };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({
        id: "shop-1", orderHistoryStartAt: null, orderReconciliationSince: null, orderReconciliationCursor: null,
      }) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "r1", succeededAt: new Date("2026-09-03T00:00:00Z"),
          amount: "0.2500", currencyCode: "AUD", order }]) },
      protectionPurchase: { findMany: vi.fn().mockResolvedValue([
        { id: "p1", purchasedAt: new Date("2026-09-02T00:00:00Z"), feeAmount: "0.5000", currencyCode: "AUD", order },
      ]) },
    };
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      shop: { currencyCode: "AUD", ianaTimezone: "Australia/Sydney" },
    } }) }) };
    const result = await readOverview({ admin, shopDomain: "one.myshopify.com", database });
    expect(result.range.preset).toBe("30");
    expect(result.trend).toHaveLength(30);
    const purchaseWhere = database.protectionPurchase.findMany.mock.calls[0][0].where;
    const refundWhere = database.protectionRefund.findMany.mock.calls[1][0].where;
    expect(purchaseWhere).toMatchObject({ shopId: "shop-1", order: { isTest: false } });
    expect(refundWhere).toMatchObject({ shopId: "shop-1", status: "CONFIRMED", order: { isTest: false } });
    expect(result.recentActivity.map((entry) => entry.kind)).toEqual(["REFUNDED", "PURCHASED"]);
  });
});
