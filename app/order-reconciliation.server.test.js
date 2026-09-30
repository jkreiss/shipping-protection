import { describe, expect, test, vi } from "vitest";
import { RECONCILIATION_OVERLAP_MS, reconcileOrders, reconciliationDue } from "./order-reconciliation.server";

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
function fakeAdmin(pages) {
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
      data = { order: fullOrder(variables.id, listed.updatedAt) };
    }
    return { json: async () => ({ data }) };
  } };
  return { admin, searches, fetched };
}

function fakeDatabase({ shop = {}, localOrders = [] } = {}) {
  const shopRow = { id: "shop-1", shopDomain, orderReconciliationSince: null, orderReconciliationCursor: null,
    orderReconciliationUntil: null, orderHistoryStartAt: null, ...shop };
  const shopUpdates = [];
  const database = {
    shop: {
      findUnique: async () => ({ ...shopRow }),
      update: async ({ data }) => { shopUpdates.push(data); Object.assign(shopRow, data); return shopRow; },
    },
    order: {
      findMany: async ({ where }) => localOrders.filter(({ shopifyOrderId }) =>
        where.shopId === "shop-1" && where.shopifyOrderId.in.includes(shopifyOrderId)),
    },
    protectionRefund: { findMany: async () => [] },
    $transaction: async (run) => run(database),
  };
  return { database, shopRow, shopUpdates };
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

    const result = await reconcileOrders({ admin, shopDomain, database, persist, hashSecret: "a-dedicated-test-secret" });

    expect(fetched).toEqual([id(2), id(3)]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ordersListed: 3, ordersFetched: 2, ordersSkipped: 1, complete: true });
  });

  test("saves the cursor after each stored page and closes the window at the end", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopUpdates, shopRow } = fakeDatabase();

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, hashSecret: "a-dedicated-test-secret" });

    expect(shopUpdates[0]).toMatchObject({ orderReconciliationCursor: "1" });
    expect(shopUpdates[1]).toMatchObject({ orderReconciliationCursor: null, orderReconciliationUntil: null });
    expect(shopRow.orderReconciliationSince).toEqual(shopUpdates[0].orderReconciliationUntil);
  });

  test("starts each new window slightly before the last one ended", async () => {
    const lastEnd = new Date("2026-09-29T12:00:00Z");
    const { admin, searches } = fakeAdmin([[]]);
    const { database } = fakeDatabase({ shop: { orderReconciliationSince: lastEnd, orderHistoryStartAt: new Date("2026-08-01T00:00:00Z") } });

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, hashSecret: "a-dedicated-test-secret" });

    const since = new Date(lastEnd.getTime() - RECONCILIATION_OVERLAP_MS).toISOString();
    expect(searches[0].query).toContain(`updated_at:>='${since}'`);
  });

  test("retries an order that lost a serialization conflict", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }]]);
    const { database } = fakeDatabase();
    const persist = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockResolvedValueOnce(undefined);

    const result = await reconcileOrders({ admin, shopDomain, database, persist, hashSecret: "a-dedicated-test-secret" });

    expect(persist).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
  });

  test("keeps the cursor when an order on the page fails to store", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopUpdates } = fakeDatabase();
    const persist = vi.fn().mockRejectedValue(new Error("database down"));

    await expect(reconcileOrders({ admin, shopDomain, database, persist, hashSecret: "a-dedicated-test-secret" }))
      .rejects.toThrow("database down");
    expect(shopUpdates).toEqual([]);
  });

  test("stops after the time budget and resumes from the saved cursor", async () => {
    const { admin } = fakeAdmin([[{ id: id(1), updatedAt: "2026-09-29T00:00:00Z" }], [{ id: id(2), updatedAt: "2026-09-29T00:01:00Z" }]]);
    const { database, shopRow } = fakeDatabase();

    const first = await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, timeBudgetMs: 0, hashSecret: "a-dedicated-test-secret" });
    expect(first).toMatchObject({ pages: 1, complete: false });
    expect(shopRow.orderReconciliationCursor).toBe("1");

    const second = await reconcileOrders({ admin, shopDomain, database, persist: async () => {}, hashSecret: "a-dedicated-test-secret" });
    expect(second).toMatchObject({ pages: 1, complete: true });
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
