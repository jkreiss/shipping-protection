import { describe, expect, test, vi } from "vitest";
import process from "node:process";
import {
  MAX_DELIVERY_ATTEMPTS, processNextDelivery, retryDelayMs, workerConcurrency,
} from "./webhook-worker.server.js";

const money = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" } });
const order = {
  id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:01:00Z",
  currencyCode: "AUD", transactions: [], transactionsCount: { count: 0 }, refunds: [],
  totalPriceSet: money("10.00"),
  lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", quantity: 1, requiresShipping: true,
    originalUnitPriceSet: money("10.00"), discountedTotalSet: money("10.00"),
    product: null, variant: null, customAttributes: [] }], pageInfo: { hasNextPage: false, endCursor: null } },
};

function worker({
  transactionError,
  installationState = "INSTALLED",
  adminForShop,
  shopifyOrder = order,
  graphqlError,
}) {
  const updates = [];
  const database = {
    shop: { findUnique: async () => ({ id: "shop-1", shopDomain: "one.myshopify.com", installationState }) },
    $transaction: async () => { throw transactionError; },
    webhookDelivery: { updateMany: async (args) => { updates.push(args); return { count: 1 }; } },
  };
  const admin = { graphql: async (query) => {
    if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
    if (graphqlError) throw graphqlError;
    return { json: async () => ({ data: { order: shopifyOrder } }) };
  } };
  const batch = { shopId: "shop-1", shopifyOrderId: order.id, leaseToken: "lease-1",
    deliveries: [
      { id: "d-1", topic: "ORDERS_PAID", attempts: MAX_DELIVERY_ATTEMPTS },
      { id: "d-2", topic: "ORDERS_UPDATED", attempts: 2 },
    ] };
  const run = async () => {
    const stderr = [];
    const stdout = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((line) => { stderr.push(JSON.parse(line)); return true; });
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((line) => { stdout.push(JSON.parse(line)); return true; });
    try {
      await processNextDelivery({
        database, claim: async () => batch, adminForShop: adminForShop ?? (async () => ({ admin })),
      });
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    return { stderr, stdout };
  };
  return { run, updates };
}

const statuses = (updates) => updates.map(({ where, data }) => [where.id, data.status]);

describe("worker failure handling", () => {
  test.each([
    ["the shop is marked uninstalled", { installationState: "UNINSTALLED" }],
    ["the shop has no offline session", {
      adminForShop: async () => { throw new (class SessionNotFoundError extends Error {})("no session"); },
    }],
    ["Shopify rejects the access token", {
      graphqlError: Object.assign(new Error("Unauthorized"), { response: { code: 401 } }),
    }],
  ])("stops quietly when %s", async (_label, options) => {
    const { run, updates } = worker(options);
    const { stderr, stdout } = await run();

    expect(statuses(updates)).toEqual([["d-1", "FAILED"], ["d-2", "FAILED"]]);
    expect(updates[0].data.errorMessage).toBe("SHOP_UNINSTALLED");
    expect(stderr.filter(({ event }) => event?.startsWith("webhook_"))).toEqual([]);
    expect(stdout.filter(({ event }) => event === "webhook_skipped_uninstalled")).toHaveLength(2);
  });

  test("fails at once when Shopify won't return the order", async () => {
    const { run, updates } = worker({ shopifyOrder: null });
    const { stderr } = await run();

    expect(statuses(updates)).toEqual([["d-1", "FAILED"], ["d-2", "FAILED"]]);
    expect(stderr.filter(({ event }) => event === "webhook_terminal")).toHaveLength(2);
  });

  test("fails at once when the order data can't be normalized", async () => {
    const { run, updates } = worker({ shopifyOrder: { ...order, currencyCode: null } });
    await run();
    expect(statuses(updates)).toEqual([["d-1", "FAILED"], ["d-2", "FAILED"]]);
  });

  test("keeps retrying a temporary error for hours", async () => {
    const { run, updates } = worker({ graphqlError: new Error("fetch failed") });
    await run();

    expect(statuses(updates)).toEqual([["d-1", "FAILED"], ["d-2", "PENDING"]]);
    let budgetMs = 0;
    for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts += 1) budgetMs += retryDelayMs(attempts);
    expect(budgetMs).toBeGreaterThan(4 * 60 * 60_000);
  });
});

describe("worker conflict handling", () => {
  test("requeues a batch that kept losing serialization conflicts without spending attempts", async () => {
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const { run, updates } = worker({ transactionError: conflict });
    await run();

    expect(updates).toHaveLength(1);
    expect(updates[0].where).toMatchObject({ shopId: "shop-1", leaseToken: "lease-1", status: "PROCESSING" });
    // Even the delivery on its last attempt goes back to the queue, not to FAILED.
    expect(updates[0].data).toMatchObject({ status: "PENDING", attempts: { decrement: 1 }, leaseToken: null });
    expect(updates[0].data.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(5_000);
  });

  test("still fails a delivery on its last attempt for other errors", async () => {
    const { run, updates } = worker({ transactionError: new Error("lease lost") });
    await run();

    expect(statuses(updates)).toEqual([["d-1", "FAILED"], ["d-2", "PENDING"]]);
  });
});

describe("worker concurrency setting", () => {
  test.each([
    [undefined, 4], ["", 4], ["1", 1], ["8", 8], ["16", 16],
  ])("WORKER_CONCURRENCY=%s runs %i delivery loops", (value, expected) => {
    expect(workerConcurrency(value)).toBe(expected);
  });

  test.each(["0", "17", "2.5", "four", "-1"])("rejects WORKER_CONCURRENCY=%s", (value) => {
    expect(() => workerConcurrency(value)).toThrow("WORKER_CONCURRENCY");
  });
});
