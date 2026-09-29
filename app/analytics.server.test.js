import { describe, expect, test, vi } from "vitest";
import { readAnalytics } from "./analytics.server.js";

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
});
