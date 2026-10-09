import { describe, expect, test, vi } from "vitest";
import {
  MAX_CONSECUTIVE_ORDER_FAILURES, RECONCILIATION_INTERVAL_MS, RECONCILIATION_OVERLAP_MS,
  reconcileOrders, reconciliationDue, shopsToReportBehind, SYNC_BEHIND_MS, SYNC_BEHIND_REPORT_EVERY_MS, syncBehindMinutes,
} from "./order-reconciliation.server";
import { retentionCutoff } from "./order-retention.js";
import * as observability from "./observability.server.js";

const shopDomain = "one.myshopify.com";
const minute = 60_000;

function fullOrder(id, updatedAt) {
  return {
    id, name: `#${id.split("/").pop()}`, createdAt: "2026-09-20T00:00:00Z", updatedAt,
    currencyCode: "AUD", transactions: [], transactionsCount: { count: 0 }, refunds: [],
    lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

// pages: listing pages of { id, updatedAt } returned in order for each cursor.
function fakeAdmin(pages, { unavailable = [] } = {}) {
  const searches = [];
  const fetched = [];
  const admin = { graphql: async (query, { variables }) => {
    if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
    let data;
    if (query.includes("query ReconcileOrders")) {
      searches.push(variables);
      const index = variables.after ? Number(variables.after) : 0;
      const hasNextPage = index + 1 < pages.length;
      data = { orders: { nodes: pages[index], pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null } } };
    } else {
      fetched.push(variables.id);
      const listed = pages.flat().find(({ id }) => id === variables.id);
      data = { order: unavailable.includes(variables.id) ? null : fullOrder(variables.id, listed.updatedAt) };
    }
    return { json: async () => ({ data }) };
  } };
  return { admin, searches, fetched };
}

function fakeDatabase({ shop = {}, localOrders = [], additionalShops = [] } = {}) {
  const shopRow = { id: "shop-1", shopDomain, orderReconciliationSince: null, orderReconciliationCursor: null,
    orderReconciliationUntil: null, orderHistoryStartAt: null, ...shop };
  const shopUpdates = [];
  const queued = [];
  const database = {
    shop: {
      findUnique: async () => ({ ...shopRow }),
      update: async ({ data }) => { shopUpdates.push(data); Object.assign(shopRow, data); return shopRow; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of [shopRow, ...additionalShops]) {
          const matches = Object.entries(where).every(([key, value]) =>
            value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value);
          if (!matches) continue;
          shopUpdates.push(data); Object.assign(row, data); count++;
        }
        return { count };
      },
    },
    order: {
      findMany: async ({ where }) => localOrders.filter(({ shopifyOrderId }) =>
        where.shopId === "shop-1" && where.shopifyOrderId.in.includes(shopifyOrderId)),
    },
    protectionRefund: { findMany: async () => [] },
    webhookDelivery: {
      upsert: vi.fn(async ({ create }) => { queued.push(create); return { id: create.webhookId }; }),
    },
    $transaction: async (run) => run(database),
  };
  return { database, shopRow, shopUpdates, queued };
}

const id = (n) => `gid://shopify/Order/${n}`;

describe("order reconciliation", () => {
  test("fetches only orders that are missing or newer in Shopify", async () => {
    const { admin, fetched } = fakeAdmin([[
      { id: id(1), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(2), updatedAt: "2026-09-29T00:05:00Z" },
      { id: id(3), updatedAt: "2026-09-29T00:10:00Z" },
    ]]);
    const { database } = fakeDatabase({ localOrders: [
      { shopifyOrderId: id(1), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
      { shopifyOrderId: id(2), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
    ] });
    const persist = vi.fn(async () => {});

    const result = await reconcileOrders({ admin, shopDomain, database, persist });

    expect(fetched).toEqual([id(2), id(3)]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ordersListed: 3, ordersFetched: 2, ordersSkipped: 1, complete: true });
  });

  test("reports progress after each page and each order it tries, so a long turn shows it is alive", async () => {
    const { admin } = fakeAdmin([[
      { id: id(1), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(2), updatedAt: "2026-09-29T00:05:00Z" },
      { id: id(3), updatedAt: "2026-09-29T00:10:00Z" },
    ]]);
    const { database } = fakeDatabase({ localOrders: [
      { shopifyOrderId: id(1), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
    ] });
    const onProgress = vi.fn();

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, onProgress });

    // One listing page, then the two orders that were missing or newer.
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  test("saves the cursor after each stored page and closes the window at the end", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopUpdates, shopRow } = fakeDatabase();

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });

    expect(shopUpdates[1]).toMatchObject({ orderReconciliationCursor: "1" });
    expect(shopUpdates[2]).toMatchObject({ orderReconciliationCursor: null, orderReconciliationUntil: null });
    expect(shopRow.orderReconciliationSince).toEqual(shopUpdates[1].orderReconciliationUntil);
  });

  test("starts each new window slightly before the last one ended", async () => {
    const lastEnd = new Date("2026-09-29T12:00:00Z");
    const { admin, searches } = fakeAdmin([[]]);
    const { database } = fakeDatabase({ shop: { orderReconciliationSince: lastEnd, orderHistoryStartAt: new Date("2026-08-01T00:00:00Z") } });

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });

    const since = new Date(lastEnd.getTime() - RECONCILIATION_OVERLAP_MS).toISOString();
    expect(searches[0].query).toContain(`updated_at:>='${since}'`);
  });

  test("retries an order that lost a serialization conflict", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }]]);
    const { database } = fakeDatabase();
    const persist = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileOrders({ admin, shopDomain, database, persist });

    expect(persist).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
  });

  test("queues an order that can't be stored and keeps reconciling the rest", async () => {
    const { admin } = fakeAdmin([[
      { id: id(1), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(2), updatedAt: "2026-09-29T00:01:00Z" },
      { id: id(3), updatedAt: "2026-09-29T00:02:00Z" },
    ], [{ id: id(4), updatedAt: "2026-09-29T00:03:00Z" }]]);
    const { database, shopUpdates, queued } = fakeDatabase();
    const persist = vi.fn(async (_transaction, _shop, normalized) => {
      if (normalized.shopifyOrderId === id(2)) throw new Error("bad order data");
    });

    const result = await reconcileOrders({ admin, shopDomain, database, persist });

    expect(persist.mock.calls.map(([, , order]) => order.shopifyOrderId)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(queued).toEqual([expect.objectContaining({
      shopId: "shop-1", shopifyOrderId: id(2), topic: "RECONCILE", status: "PENDING",
      webhookId: `reconcile:${id(2)}:2026-09-29T00:01:00Z`,
    })]);
    expect(result).toMatchObject({ complete: true, ordersFetched: 3, ordersFailed: 1, ordersSkipped: 0 });
    expect(shopUpdates.at(-1)).toMatchObject({ orderReconciliationCursor: null });
  });

  test("keeps reconciling past adjacent orders Shopify will never return", async () => {
    const { admin } = fakeAdmin([[
      { id: id(1), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(2), updatedAt: "2026-09-29T00:01:00Z" },
      { id: id(3), updatedAt: "2026-09-29T00:02:00Z" },
      { id: id(4), updatedAt: "2026-09-29T00:03:00Z" },
    ], [{ id: id(5), updatedAt: "2026-09-29T00:04:00Z" }]], { unavailable: [id(1), id(2), id(3), id(4)] });
    const { database, shopUpdates, queued } = fakeDatabase();
    const persist = vi.fn(async () => {});

    const result = await reconcileOrders({ admin, shopDomain, database, persist });

    expect(persist.mock.calls.map(([, , order]) => order.shopifyOrderId)).toEqual([id(5)]);
    // Queued so the worker fails each at once and leaves a durable record.
    expect(queued.map(({ shopifyOrderId }) => shopifyOrderId)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(result).toMatchObject({ complete: true, ordersFetched: 1, ordersFailed: 4 });
    expect(shopUpdates.at(-1)).toMatchObject({ orderReconciliationCursor: null });
  });

  test("stops and keeps the cursor when orders keep failing in a row", async () => {
    const { admin } = fakeAdmin([[
      { id: id(1), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(2), updatedAt: "2026-09-29T00:01:00Z" },
      { id: id(3), updatedAt: "2026-09-29T00:02:00Z" },
    ], [{ id: id(4), updatedAt: "2026-09-29T00:03:00Z" }]]);
    const { database, shopUpdates } = fakeDatabase();
    const persist = vi.fn().mockRejectedValue(new Error("shopify down"));

    await expect(reconcileOrders({ admin, shopDomain, database, persist }))
      .rejects.toThrow("shopify down");
    expect(persist).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ORDER_FAILURES);
    expect(shopUpdates).toHaveLength(1);
    expect(shopUpdates[0]).toMatchObject({ orderReconciliationCursor: null, orderReconciliationUntil: expect.any(Date) });
  });

  test("keeps the cursor when a failed order can't be queued", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopUpdates } = fakeDatabase();
    database.webhookDelivery.upsert.mockRejectedValue(new Error("database down"));
    const persist = vi.fn().mockRejectedValue(new Error("database down"));

    await expect(reconcileOrders({ admin, shopDomain, database, persist }))
      .rejects.toThrow("database down");
    expect(shopUpdates).toHaveLength(1);
    expect(shopUpdates[0]).toMatchObject({ orderReconciliationCursor: null, orderReconciliationUntil: expect.any(Date) });
  });

  test("stops after the time budget and resumes from the saved cursor", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopRow } = fakeDatabase();

    const first = await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, timeBudgetMs: 0 });
    expect(first).toMatchObject({ pages: 1, complete: false });
    expect(shopRow.orderReconciliationCursor).toBe("1");

    const second = await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });
    expect(second).toMatchObject({ pages: 1, complete: true });
  });
});

describe("pending refund recheck", () => {
  test("polls only pending refunds, least recently checked first", async () => {
    const { admin } = fakeAdmin([[]]);
    const { database } = fakeDatabase();
    database.protectionRefund.findMany = vi.fn(async () => []);
    const before = Date.now();

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });

    const [args] = database.protectionRefund.findMany.mock.calls[0];
    expect(args).toMatchObject({
      where: { shopId: "shop-1", status: "PENDING" },
      orderBy: { updatedAt: "asc" },
      distinct: ["orderId"],
      take: 20,
    });
    expect(args.where.updatedAt.lt.getTime()).toBeLessThanOrEqual(before - RECONCILIATION_INTERVAL_MS + 1000);
  });

  test("leaves out refunds on orders past retention, which are never stored again", async () => {
    const { admin } = fakeAdmin([[]]);
    const { database } = fakeDatabase();
    database.protectionRefund.findMany = vi.fn(async () => []);

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });

    const { where } = database.protectionRefund.findMany.mock.calls[0][0];
    expect(where.order.shopifyCreatedAt.gte).toBeInstanceOf(Date);
    expect(Math.abs(where.order.shopifyCreatedAt.gte.getTime() - retentionCutoff(new Date()).getTime())).toBeLessThan(5_000);
  });

  test("reports progress after each refund recheck", async () => {
    const pending = [
      { orderId: "order-7", order: { shopifyOrderId: id(7) } },
      { orderId: "order-8", order: { shopifyOrderId: id(8) } },
    ];
    const { admin } = fakeAdmin([[
      { id: id(7), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(8), updatedAt: "2026-09-29T00:00:00Z" },
    ]]);
    const { database } = fakeDatabase({ localOrders: [
      { shopifyOrderId: id(7), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
      { shopifyOrderId: id(8), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
    ] });
    database.protectionRefund.findMany = vi.fn(async () => pending);
    const onProgress = vi.fn();

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, onProgress });

    // One listing page (both orders already stored), then two rechecks.
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  test("a recheck that fails moves to the back and doesn't stop the others", async () => {
    const pending = [
      { orderId: "order-7", order: { shopifyOrderId: id(7) } },
      { orderId: "order-8", order: { shopifyOrderId: id(8) } },
    ];
    const { admin, fetched } = fakeAdmin([[
      { id: id(7), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(8), updatedAt: "2026-09-29T00:00:00Z" },
    ]]);
    const { database } = fakeDatabase({ localOrders: [
      { shopifyOrderId: id(7), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
      { shopifyOrderId: id(8), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
    ] });
    database.protectionRefund.findMany = vi.fn(async () => pending);
    database.protectionRefund.updateMany = vi.fn(async () => ({ count: 1 }));
    const persist = vi.fn(async (_transaction, _shop, normalized) => {
      if (normalized.shopifyOrderId === id(7)) throw new Error("bad order data");
    });

    const result = await reconcileOrders({ admin, shopDomain, database, persist });

    expect(fetched).toEqual([id(7), id(8)]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(database.protectionRefund.updateMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", orderId: "order-7", status: "PENDING" },
      data: { updatedAt: expect.any(Date) },
    });
    expect(result.complete).toBe(true);
  });
});

describe("pending refund recheck for an unavailable order", () => {
  test("stops rechecking it, keeps the row unresolved and does not alert", async () => {
    const pending = [
      { orderId: "order-7", order: { shopifyOrderId: id(7) } },
      { orderId: "order-8", order: { shopifyOrderId: id(8) } },
    ];
    const { admin, fetched } = fakeAdmin([[
      { id: id(7), updatedAt: "2026-09-29T00:00:00Z" },
      { id: id(8), updatedAt: "2026-09-29T00:00:00Z" },
    ]], { unavailable: [id(7)] });
    const { database } = fakeDatabase({ localOrders: [
      { shopifyOrderId: id(7), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
      { shopifyOrderId: id(8), shopifyUpdatedAt: new Date("2026-09-29T00:00:00Z") },
    ] });
    database.protectionRefund.findMany = vi.fn(async () => pending);
    database.protectionRefund.updateMany = vi.fn(async () => ({ count: 1 }));
    const persist = vi.fn(async () => {});
    const report = vi.spyOn(observability, "reportFailure").mockImplementation(() => {});
    const onProgress = vi.fn();

    try {
      await reconcileOrders({ admin, shopDomain, database, persist, onProgress });

      expect(fetched).toEqual([id(7), id(8)]);
      // Only the readable order is stored again; the other is closed out, never confirmed.
      expect(persist).toHaveBeenCalledTimes(1);
      expect(database.protectionRefund.updateMany).toHaveBeenCalledTimes(1);
      expect(database.protectionRefund.updateMany).toHaveBeenCalledWith({
        where: { shopId: "shop-1", orderId: "order-7", status: "PENDING" },
        data: { status: "UNATTRIBUTED" },
      });
      expect(report).not.toHaveBeenCalledWith("refund_recheck_failed", expect.anything(), expect.anything());
      // One listing page, then both rechecks still report progress.
      expect(onProgress).toHaveBeenCalledTimes(3);
    } finally {
      report.mockRestore();
    }
  });
});

describe("when a shop needs reconciling", () => {
  const now = new Date("2026-09-30T00:00:00Z");

  test.each([
    ["has never reconciled", { orderReconciliationSince: null }, true],
    ["is part way through a window", { orderReconciliationSince: new Date(now - minute), orderReconciliationCursor: "abc" }, true],
    ["finished a window 11 minutes ago", { orderReconciliationSince: new Date(now - 11 * minute) }, true],
    ["finished a window 2 minutes ago", { orderReconciliationSince: new Date(now - 2 * minute) }, false],
  ])("a shop that %s: %s", (_label, shop, due) => {
    expect(reconciliationDue({ orderReconciliationCursor: null, ...shop }, now)).toBe(due);
  });
});

describe("order sync falling behind", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const syncedAgo = (ms) => ({ id: "shop", orderReconciliationSince: new Date(now.getTime() - ms) });

  test("reports whole minutes only once past the threshold", () => {
    expect(syncBehindMinutes(syncedAgo(SYNC_BEHIND_MS), now)).toBeNull();
    expect(syncBehindMinutes(syncedAgo(SYNC_BEHIND_MS + 1), now)).toBe(30);
    expect(syncBehindMinutes(syncedAgo(95 * minute + 59_000), now)).toBe(95);
  });

  test("ignores a shop that has not completed a first window", () => {
    expect(syncBehindMinutes({ id: "shop", orderReconciliationSince: null }, now)).toBeNull();
  });

  test("reports a behind shop once per interval and again after it", () => {
    const reportedAt = new Map();
    const shops = [syncedAgo(45 * minute)];

    expect(shopsToReportBehind(shops, reportedAt, now)).toEqual([{ shopId: "shop", minutesBehind: 45 }]);
    expect(shopsToReportBehind(shops, reportedAt, new Date(now.getTime() + SYNC_BEHIND_REPORT_EVERY_MS - 1))).toEqual([]);
    expect(shopsToReportBehind(shops, reportedAt, new Date(now.getTime() + SYNC_BEHIND_REPORT_EVERY_MS))).toHaveLength(1);
  });

  test("reports again promptly when a recovered shop falls behind a second time", () => {
    const reportedAt = new Map();
    shopsToReportBehind([syncedAgo(45 * minute)], reportedAt, now);
    expect(shopsToReportBehind([syncedAgo(5 * minute)], reportedAt, now)).toEqual([]);
    expect(shopsToReportBehind([syncedAgo(40 * minute)], reportedAt, now)).toHaveLength(1);
  });

  test("tracks shops independently and skips current ones", () => {
    const shops = [{ ...syncedAgo(10 * minute), id: "fresh" }, { ...syncedAgo(60 * minute), id: "stale" }];
    expect(shopsToReportBehind(shops, new Map(), now)).toEqual([{ shopId: "stale", minutesBehind: 60 }]);
  });
});

test.each([false, true])(
  "reset during an in-flight page cannot restore old progress (first window: %s)",
  async (firstWindow) => {
    const { database, shopRow } = fakeDatabase({
      shop: firstWindow
        ? {}
        : {
            orderReconciliationSince: new Date("2026-09-28T00:00:00Z"),
            orderReconciliationUntil: new Date("2026-09-29T00:00:00Z"),
            orderReconciliationCursor: "1",
          },
    });
    const otherTenant = {
      id: "shop-2",
      orderReconciliationCursor: "other",
      orderReconciliationSince: new Date("2026-09-01"),
    };
    const before = structuredClone(otherTenant);
    const admin = {
      graphql: async () => {
        Object.assign(shopRow, {
          orderReconciliationSince: null,
          orderReconciliationUntil: null,
          orderReconciliationCursor: null,
        });
        return {
          json: async () => ({
            data: {
              orders: {
                nodes: [],
                pageInfo: { hasNextPage: true, endCursor: "stale" },
              },
            },
          }),
        };
      },
    };
    const result = await reconcileOrders({
      admin,
      shopDomain,
      database,
      maxPages: 1,
    });
    expect(result).toMatchObject({ complete: false, superseded: true });
    expect(shopRow).toMatchObject({
      orderReconciliationSince: null,
      orderReconciliationUntil: null,
      orderReconciliationCursor: null,
    });
    expect(otherTenant).toEqual(before);
  },
);
test("another worker claiming the initial window supersedes a turn before its fetch", async () => {
  const { database, shopRow } = fakeDatabase();
  const read = database.shop.findUnique;
  database.shop.findUnique = async () => {
    const snapshot = await read();
    shopRow.orderReconciliationUntil = new Date("2026-09-29");
    return snapshot;
  };
  const { admin, searches } = fakeAdmin([[]]);
  const result = await reconcileOrders({ admin, shopDomain, database });
  expect(result).toMatchObject({ complete: false, superseded: true });
  expect(searches).toEqual([]);
});
test("an initial window awaiting its first page stays due despite a recent watermark", () => {
  expect(
    reconciliationDue({
      orderReconciliationSince: new Date(),
      orderReconciliationCursor: null,
      orderReconciliationUntil: new Date(),
    }),
  ).toBe(true);
});

test("normal progress leaves another tenant with identical reconciliation state unchanged", async () => {
  const other = { id: "shop-2", shopDomain: "two.myshopify.com", orderReconciliationSince: null,
    orderReconciliationCursor: null, orderReconciliationUntil: null };
  const { database, shopRow } = fakeDatabase({ additionalShops: [other] });
  const { admin } = fakeAdmin([[]]);
  expect((await reconcileOrders({ admin, shopDomain, database })).complete).toBe(true);
  expect(shopRow.orderReconciliationSince).toBeInstanceOf(Date);
  expect(other).toEqual({ id: "shop-2", shopDomain: "two.myshopify.com", orderReconciliationSince: null,
    orderReconciliationCursor: null, orderReconciliationUntil: null });
});
