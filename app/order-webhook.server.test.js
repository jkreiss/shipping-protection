import { describe, expect, test, vi } from "vitest";
import { processOrderWebhook } from "./order-ingestion.server";

const secret = "a-dedicated-test-secret";

function payload(id = 1) {
  return {
    id,
    name: `#${id}`,
    created_at: "2026-09-23T00:00:00Z",
    updated_at: "2026-09-23T00:01:00Z",
    processed_at: "2026-09-23T00:00:30Z",
    currency: "AUD",
    subtotal_price: "100.00",
    total_price: "100.00",
    total_discounts: "0.00",
    total_tax: "0.00",
    line_items: [
      {
        id: id * 10,
        product_id: 1,
        variant_id: 2,
        quantity: 1,
        price: "100.00",
        total_discount: "0.00",
        requires_shipping: true,
        properties: [],
      },
    ],
  };
}

function memoryDatabase({ failOrders = false } = {}) {
  const shops = new Map();
  const deliveries = new Map();
  const orders = new Map();
  let nextShop = 1;

  const shop = {
    upsert: vi.fn(async ({ where }) => {
      if (!shops.has(where.shopDomain)) {
        shops.set(where.shopDomain, {
          id: `shop-${nextShop++}`,
          shopDomain: where.shopDomain,
        });
      }
      return shops.get(where.shopDomain);
    }),
    findUnique: vi.fn(async ({ where }) => shops.get(where.shopDomain) ?? null),
  };
  const webhookDelivery = {
    findUnique: vi.fn(async ({ where }) => {
      const { shopId, webhookId } = where.shopId_webhookId;
      return deliveries.get(`${shopId}:${webhookId}`) ?? null;
    }),
    create: vi.fn(async ({ data }) => {
      const delivery = { id: `delivery-${deliveries.size + 1}`, status: "PROCESSING", ...data };
      deliveries.set(`${data.shopId}:${data.webhookId}`, delivery);
      return delivery;
    }),
    update: vi.fn(async ({ where, data }) => {
      const delivery = [...deliveries.values()].find(({ id }) => id === where.id);
      Object.assign(delivery, data);
      return delivery;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      const { shopId, webhookId } = where.shopId_webhookId;
      const key = `${shopId}:${webhookId}`;
      const delivery = deliveries.get(key);
      if (delivery) {
        Object.assign(delivery, update);
        return delivery;
      }
      const created = { id: `delivery-${deliveries.size + 1}`, ...create };
      deliveries.set(key, created);
      return created;
    }),
  };
  const order = {
    findUnique: vi.fn(async ({ where }) => {
      const key = `${where.shopId_shopifyOrderId.shopId}:${where.shopId_shopifyOrderId.shopifyOrderId}`;
      return orders.get(key) ?? null;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      if (failOrders) throw new Error("database unavailable\nsecret detail");
      const key = `${where.shopId_shopifyOrderId.shopId}:${where.shopId_shopifyOrderId.shopifyOrderId}`;
      const record = orders.get(key) ?? { id: `order-${orders.size + 1}` };
      Object.assign(record, orders.has(key) ? update : create);
      orders.set(key, record);
      return record;
    }),
  };
  const transaction = {
    shop,
    webhookDelivery,
    pricingRule: { findMany: vi.fn().mockResolvedValue([]) },
    order,
    orderLine: { deleteMany: vi.fn(), createMany: vi.fn() },
    protectionPurchase: { deleteMany: vi.fn(), upsert: vi.fn() },
  };
  return {
    database: {
      ...transaction,
      $transaction: vi.fn((callback) => callback(transaction)),
    },
    deliveries,
    orders,
  };
}

describe("orders/create delivery processing", () => {
  test("deduplicates a repeated webhook ID", async () => {
    const { database, orders } = memoryDatabase();
    const options = {
      shopDomain: "one.myshopify.com",
      webhookId: "webhook-1",
      eventId: "event-1",
      payload: payload(),
      hashSecret: secret,
      database,
    };
    expect(await processOrderWebhook(options)).toMatchObject({ duplicate: false });
    expect(await processOrderWebhook(options)).toEqual({
      duplicate: true,
      order: null,
    });
    expect(orders.size).toBe(1);
  });

  test("the same delivery ID remains isolated between shops", async () => {
    const { database, orders } = memoryDatabase();
    await processOrderWebhook({
      shopDomain: "one.myshopify.com",
      webhookId: "same-id",
      payload: payload(1),
      hashSecret: secret,
      database,
    });
    await processOrderWebhook({
      shopDomain: "two.myshopify.com",
      webhookId: "same-id",
      payload: payload(1),
      hashSecret: secret,
      database,
    });
    expect(orders.size).toBe(2);
  });

  test("records a sanitized failure and rethrows for Shopify retry", async () => {
    const { database, deliveries } = memoryDatabase({ failOrders: true });
    await expect(
      processOrderWebhook({
        shopDomain: "one.myshopify.com",
        webhookId: "webhook-failed",
        payload: payload(),
        hashSecret: secret,
        database,
      }),
    ).rejects.toThrow("database unavailable");
    expect([...deliveries.values()][0]).toMatchObject({
      status: "FAILED",
      errorMessage: "database unavailable secret detail",
    });
  });

  test("records malformed payloads as failed deliveries", async () => {
    const { database, deliveries } = memoryDatabase();
    await expect(
      processOrderWebhook({
        shopDomain: "one.myshopify.com",
        webhookId: "webhook-malformed",
        payload: {},
        hashSecret: secret,
        database,
      }),
    ).rejects.toThrow("Malformed orders/create payload");
    expect([...deliveries.values()][0].status).toBe("FAILED");
  });
});
