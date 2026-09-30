import { describe, expect, test, vi } from "vitest";
import process from "node:process";
import { processNextDelivery, workerConcurrency } from "./webhook-worker.server.js";

const money = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" } });
const order = {
  id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:01:00Z",
  currencyCode: "AUD", transactions: [], transactionsCount: { count: 0 }, refunds: [],
  totalPriceSet: money("10.00"),
  lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", quantity: 1, requiresShipping: true,
    originalUnitPriceSet: money("10.00"), discountedTotalSet: money("10.00"),
    product: null, variant: null, customAttributes: [] }], pageInfo: { hasNextPage: false, endCursor: null } },
};

function worker({ transactionError }) {
  const updates = [];
  const database = {
    shop: { findUnique: async () => ({ id: "shop-1", shopDomain: "one.myshopify.com", installationState: "INSTALLED" }) },
    $transaction: async () => { throw transactionError; },
    webhookDelivery: { updateMany: async (args) => { updates.push(args); return { count: 1 }; } },
  };
  const admin = { graphql: async (query) => {
    if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
    return { json: async () => ({ data: { order } }) };
  } };
  const batch = { shopId: "shop-1", shopifyOrderId: order.id, leaseToken: "lease-1",
    deliveries: [{ id: "d-1", topic: "ORDERS_PAID", attempts: 8 }, { id: "d-2", topic: "ORDERS_UPDATED", attempts: 2 }] };
  const run = () => processNextDelivery({
    database, claim: async () => batch, adminForShop: async () => ({ admin }), hashSecret: "a-dedicated-test-secret",
  });
  return { run, updates };
}

describe("worker conflict handling", () => {
  test("requeues a batch that kept losing serialization conflicts without spending attempts", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    const { run, updates } = worker({ transactionError: conflict });
    try {
      await run();
    } finally {
      stderr.mockRestore();
    }

    expect(updates).toHaveLength(1);
    expect(updates[0].where).toMatchObject({ shopId: "shop-1", leaseToken: "lease-1", status: "PROCESSING" });
    // Even the delivery on its last attempt goes back to the queue, not to FAILED.
    expect(updates[0].data).toMatchObject({ status: "PENDING", attempts: { decrement: 1 }, leaseToken: null });
    expect(updates[0].data.nextAttemptAt.getTime() - Date.now()).toBeLessThanOrEqual(5_000);
  });

  test("still fails a delivery on its last attempt for other errors", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { run, updates } = worker({ transactionError: new Error("lease lost") });
    try {
      await run();
    } finally {
      stderr.mockRestore();
    }

    expect(updates.map(({ where, data }) => [where.id, data.status])).toEqual([["d-1", "FAILED"], ["d-2", "PENDING"]]);
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
