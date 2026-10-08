// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockAdminServer } from "../../scripts/load/mock-shopify.js";
import { adminGraphql } from "./admin-graphql.server.js";
import { fetchShopifyOrder, ORDERS_QUERY } from "../order-shopify.server.js";
import { normalizeGraphqlOrder } from "../order-normalization.js";
import { readOverview } from "../analytics.server.js";
import { reconcileOrders } from "../order-reconciliation.server.js";
import { createServer } from "node:http";

let server;
let origin;
const options = { token: "test-mock-only", shops: 2, ordersPerShop: 12,
  startAt: "2026-09-01T00:00:00.000Z", intervalMs: 1000, latencyMs: 0, jitterMs: 0 };
beforeEach(async () => {
  server = createMockAdminServer(options);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  vi.stubEnv("APP_ENV", "load");
  vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", origin);
  vi.stubEnv("SHOPIFY_ADMIN_MOCK_TOKEN", options.token);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
const realAdmin = { graphql: () => { throw new Error("Must never reach Shopify"); } };
const shop = "load-1.myshopify.com";

test("the actual fetch and normalization path reads a paid protected order and refund", async () => {
  const order = normalizeGraphqlOrder(await fetchShopifyOrder(realAdmin, "gid://shopify/Order/10", { shop }));
  expect(order.totalAmount).toBe("102.0000");
  expect(order.paidAt.toISOString()).toBe("2026-09-01T00:00:09.000Z");
  expect(order.lines[1].variantId).toBe("gid://shopify/ProductVariant/9001");
  expect(order.refunds[0].totalRefundedSet.shopMoney.amount).toBe("2.00");
  expect(order.isTest).toBe(false);
});

test("reconciliation filters its window and advances tenant-bound cursors", async () => {
  const variables = { first: 2, query: "updated_at:>='2026-09-01T00:00:02Z' updated_at:<='2026-09-01T00:00:05Z'" };
  const first = await adminGraphql(realAdmin, ORDERS_QUERY, variables, { shop });
  expect(first.orders.nodes.map(({ id }) => id)).toEqual(["gid://shopify/Order/3", "gid://shopify/Order/4"]);
  const after = first.orders.pageInfo.endCursor;
  const second = await adminGraphql(realAdmin, ORDERS_QUERY, { ...variables, after }, { shop });
  expect(second.orders.nodes.map(({ id }) => id)).toEqual(["gid://shopify/Order/5", "gid://shopify/Order/6"]);
  expect(second.orders.pageInfo.hasNextPage).toBe(false);
  await expect(adminGraphql(realAdmin, ORDERS_QUERY, { ...variables, after }, { shop: "load-2.myshopify.com" })).rejects.toThrow(/cursor/i);
});

test("initial backfill resumes its original window across turns and skips stored orders on a new scan", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
  const shopRow = { id: "backfill-shop", shopDomain: shop, orderReconciliationSince: null,
    orderReconciliationUntil: null, orderReconciliationCursor: null, orderHistoryStartAt: null };
  const stored = new Map();
  const database = {
    shop: {
      findUnique: async () => ({ ...shopRow }),
      updateMany: async ({ where, data }) => {
        const matches = Object.entries(where).every(([key, value]) =>
          value instanceof Date ? shopRow[key]?.getTime() === value.getTime() : shopRow[key] === value);
        if (!matches) return { count: 0 };
        Object.assign(shopRow, data); return { count: 1 };
      },
    },
    order: { findMany: async ({ where }) => [...stored.values()].filter(({ shopifyOrderId }) =>
      where.shopId === shopRow.id && where.shopifyOrderId.in.includes(shopifyOrderId)) },
    protectionRefund: { findMany: async () => [] },
    $transaction: async (run) => run(database),
  };
  const persist = async (_transaction, _shop, order) => {
    stored.set(order.shopifyOrderId, { shopifyOrderId: order.shopifyOrderId, shopifyUpdatedAt: order.shopifyUpdatedAt });
  };
  const reconcile = () => reconcileOrders({ admin: realAdmin, shopDomain: shop, database,
    persist, pageSize: 4, timeBudgetMs: 0 });

  const first = await reconcile();
  expect(first).toMatchObject({ complete: false, ordersFetched: 4,
    windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-10-01T00:00:00.000Z" });

  // Each turn uses a fresh database read, as it would after a worker restart.
  vi.setSystemTime(new Date("2026-10-01T00:05:00.000Z"));
  const second = await reconcile();
  expect(second).toMatchObject({ complete: false, ordersFetched: 4,
    windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-10-01T00:00:00.000Z" });

  vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
  const third = await reconcile();
  expect(third).toMatchObject({ complete: true, ordersFetched: 4,
    windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-10-01T00:00:00.000Z" });
  expect([...stored.keys()]).toEqual(Array.from({ length: 12 }, (_, index) => `gid://shopify/Order/${index + 1}`));
  expect(shopRow).toMatchObject({ orderReconciliationSince: new Date("2026-10-01T00:00:00.000Z"),
    orderReconciliationUntil: null, orderReconciliationCursor: null });

  // The load campaign resets discovery for a second scan, keeping historical metadata.
  shopRow.orderReconciliationSince = null;
  const repeated = await reconcile();
  expect(repeated).toMatchObject({ ordersFetched: 0, ordersSkipped: 4,
    windowStart: "2026-08-03T00:00:00.000Z", windowEnd: "2026-10-02T00:00:00.000Z" });
  vi.setSystemTime(new Date("2026-10-02T00:05:00.000Z"));
  expect(await reconcile()).toMatchObject({ complete: false, ordersFetched: 0, ordersSkipped: 4 });
  vi.setSystemTime(new Date("2026-10-02T00:10:00.000Z"));
  expect(await reconcile()).toMatchObject({ complete: true, ordersFetched: 0, ordersSkipped: 4 });
  expect(stored.size).toBe(12);
});

test("rejects real tenants and unknown fake tenants", async () => {
  await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop: "real.myshopify.com" })).rejects.toThrow(/tenant/i);
  await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop: "load-3.myshopify.com" })).rejects.toThrow(/404/);
  await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/13", { shop })).rejects.toThrow(/unavailable/);
});

test("does not forward Shopify access tokens and authenticates the mock", async () => {
  const headers = [];
  server.on("request", (req) => headers.push(req.headers));
  await fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop });
  expect(headers[0]["x-shopify-access-token"]).toBeUndefined();
  expect(headers[0].authorization).toBe("Bearer test-mock-only");
  vi.stubEnv("SHOPIFY_ADMIN_MOCK_TOKEN", "wrong");
  await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop })).rejects.toThrow(/401/);
});

test("rejects redirects without requesting their destination", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  let requests = 0;
  server = createServer((request, response) => {
    requests += 1;
    response.writeHead(302, { Location: "/redirect-destination" });
    response.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", `http://127.0.0.1:${server.address().port}`);
  await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop })).rejects.toThrow();
  expect(requests).toBe(1);
});

test("the Overview can load its shop metadata through the mock", async () => {
  const database = {
    shop: { findUnique: async () => ({ id: "fake-shop", orderReconciliationSince: null, orderHistoryStartAt: null }) },
    order: { findMany: async () => [] },
    protectionRefund: { findMany: async () => [] },
    protectionPurchase: { findMany: async () => [] },
  };
  const result = await readOverview({ admin: realAdmin, shopDomain: shop, database });
  expect(result.currencyCode).toBe("AUD");
  expect(result.timeZone).toBe("Australia/Sydney");
  expect(result.trend).toHaveLength(30);
});

test.each([[{ http429Every: 1 }, /429/], [{ http500Every: 1 }, /500/], [{ throttleEvery: 1 }, /Throttled/]])(
  "fault injection reaches the real retry boundary: %j", async (fault, error) => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = createMockAdminServer({ ...options, ...fault });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", `http://127.0.0.1:${server.address().port}`);
    await expect(fetchShopifyOrder(realAdmin, "gid://shopify/Order/1", { shop, sleep: async () => {} })).rejects.toThrow(error);
  },
);
