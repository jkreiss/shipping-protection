import { describe, expect, test, vi } from "vitest";
import process from "node:process";
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

  test("flags history as limited for a range reaching past the retention cutoff", async () => {
    const shop = {
      id: "shop-1", orderHistoryStartAt: new Date("2024-01-01T00:00:00Z"),
      orderReconciliationSince: new Date("2026-10-07T00:00:00Z"), orderReconciliationCursor: null,
    };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue(shop) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      shop: { currencyCode: "USD", ianaTimezone: "UTC" },
    } }) }) };
    const now = new Date("2026-10-08T12:00:00Z");
    const read = (start) => readAnalytics({ admin, shopDomain: "one.myshopify.com", database, now,
      search: new URLSearchParams(`range=custom&start=${start}&end=2026-10-01`) });

    expect((await read("2024-06-01")).sync.historyLimited).toBe(true);
    expect((await read("2024-10-08")).sync.historyLimited).toBe(false);
  });

  test("overview reads a fixed 30-day window and tenant-scoped recent activity", async () => {
    const order = { name: "#1001", shopifyOrderId: "gid://shopify/Order/1" };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({
        id: "shop-1", orderHistoryStartAt: null, orderReconciliationSince: null, orderReconciliationCursor: null,
      }) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn()
        .mockImplementation(async ({ where }) => where.status === "CONFIRMED" ? [{ id: "r1", succeededAt: new Date("2026-09-03T00:00:00Z"),
          amount: "0.2500", currencyCode: "AUD", order }] : []) },
      protectionPurchase: { findMany: vi.fn().mockResolvedValue([
        { id: "p1", purchasedAt: new Date("2026-09-02T00:00:00Z"), feeAmount: "0.5000", currencyCode: "AUD", order },
      ]) },
    };
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      shop: { currencyCode: "AUD", ianaTimezone: "Australia/Sydney" },
    } }) }) };
    const result = await readOverview({ admin, shopDomain: "one.myshopify.com", database, now: new Date("2020-01-01T14:00:00Z") });
    expect(result.range).toMatchObject({ end: "2020-01-02" });
    expect(database.shop.findUnique).toHaveBeenCalledTimes(1);
    expect(result.range).toMatchObject({ start: "2019-12-04", end: "2020-01-02" });
    expect(result.trend[0].date).toBe("2019-12-04");
    expect(result.trend[29].date).toBe("2020-01-02");
    expect(database.order.findMany.mock.calls[0][0].where.OR[0].firstPaidAt).toEqual({ gte: new Date("2019-12-03T00:00:00Z"), lt: new Date("2020-01-04T00:00:00Z") });
    expect(result.range.preset).toBe("30");
    expect(result.trend).toHaveLength(30);
    const purchaseWhere = database.protectionPurchase.findMany.mock.calls[0][0].where;
    const refundWhere = database.protectionRefund.findMany.mock.calls.find(([query]) => query.where.status === "CONFIRMED")[0].where;
    expect(purchaseWhere).toMatchObject({ shopId: "shop-1", order: { isTest: false } });
    expect(refundWhere).toMatchObject({ shopId: "shop-1", status: "CONFIRMED", order: { isTest: false } });
    expect(result.recentActivity.map((entry) => entry.kind)).toEqual(["REFUNDED", "PURCHASED"]);
  });
});

describe("order sync status", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const admin = { graphql: async () => ({ json: async () => ({ data: {
    shop: { currencyCode: "AUD", ianaTimezone: "Australia/Sydney" },
  } }) }) };
  function database({ syncedAt, cursor = null }) {
    return {
      shop: { findUnique: vi.fn().mockResolvedValue({
        id: "shop-1", orderHistoryStartAt: new Date("2026-08-01T00:00:00Z"),
        orderReconciliationSince: syncedAt, orderReconciliationCursor: cursor,
      }) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }
  const read = (db) => readAnalytics({ admin, shopDomain: "one.myshopify.com",
    search: new URLSearchParams("range=30"), database: db, now });

  // Single orders that fail to store alert the operator, not the merchant.
  test("is current when the last sync finished recently", async () => {
    expect((await read(database({ syncedAt: new Date("2026-09-30T11:50:00Z") }))).sync.behind).toBe(false);
  });

  test("is behind when the last completed sync is over an hour old", async () => {
    expect((await read(database({ syncedAt: new Date("2026-09-30T10:30:00Z") }))).sync.behind).toBe(true);
  });

  test("is not behind while the first backfill is still running", async () => {
    const result = await read(database({ syncedAt: null, cursor: "abc" }));
    expect(result.sync).toMatchObject({ complete: false, behind: false });
  });

  test("logs how long the Overview took to load", async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
    const db = { ...database({ syncedAt: new Date("2026-09-30T11:50:00Z") }),
      protectionPurchase: { findMany: vi.fn().mockResolvedValue([]) } };
    try {
      await readOverview({ admin, shopDomain: "one.myshopify.com", database: db, now });
    } finally {
      spy.mockRestore();
    }
    const events = writes.map((line) => JSON.parse(line)).filter(({ event }) => event === "overview_loaded");
    expect(events).toEqual([expect.objectContaining({ shopId: "shop-1", orderRows: 0, refundRows: 0 })]);
    expect(events[0].durationMs).toEqual(expect.any(Number));
  });
});


test("Overview starts tenant-scoped activity while Shopify analytics is still pending", async () => {
  let finishShopify;
  const response = new Promise((resolve) => { finishShopify = resolve; });
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-2", orderHistoryStartAt: null, orderReconciliationSince: null }) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    protectionRefund: { findMany: vi.fn().mockResolvedValue([]) },
    protectionPurchase: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const admin = { graphql: vi.fn(() => response) };
  const reading = readOverview({ admin, shopDomain: "two.myshopify.com", database });
  try {
    await vi.waitFor(() => expect(admin.graphql).toHaveBeenCalled());
    expect(database.protectionPurchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ shopId: "shop-2" }) }));
    expect(database.order.findMany).not.toHaveBeenCalled();
  } finally {
    finishShopify({ json: async () => ({ data: { shop: { currencyCode: "USD", ianaTimezone: "America/New_York" } } }) });
    await reading;
  }
});

test("Overview rejects an unavailable tenant before financial reads", async () => {
  const admin = { graphql: vi.fn() };
  const database = { shop: { findUnique: vi.fn().mockResolvedValue(null) }, protectionPurchase: { findMany: vi.fn() } };
  await expect(readOverview({ admin, shopDomain: "missing.myshopify.com", database })).rejects.toThrow("not installed");
  expect(admin.graphql).not.toHaveBeenCalled();
  expect(database.protectionPurchase.findMany).not.toHaveBeenCalled();
});
