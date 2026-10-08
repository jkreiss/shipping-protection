import { describe, expect, test, vi } from "vitest";
import { orderIdFromWebhook, PermanentWebhookError, receiveOrderWebhook } from "./webhook-inbox.server.js";

function memoryDatabase() {
  const rows = new Map();
  const database = {
    shop: { findUnique: vi.fn(async ({ where }) => ({
      id: where.shopDomain, installationState: "INSTALLED",
    })) },
    webhookDelivery: { upsert: vi.fn(async ({ where, create }) => {
      const key = `${where.shopId_webhookId.shopId}:${where.shopId_webhookId.webhookId}`;
      if (!rows.has(key)) rows.set(key, { id: `delivery-${rows.size + 1}`, ...create });
      return rows.get(key);
    }) },
  };
  return { database, rows };
}

describe("durable order webhook receipt", () => {
  test("extracts only a valid order ID, including refunds", () => {
    expect(orderIdFromWebhook("ORDERS_PAID", { id: 123 })).toBe("gid://shopify/Order/123");
    expect(orderIdFromWebhook("REFUNDS_CREATE", { order_id: 123 })).toBe("gid://shopify/Order/123");
    expect(() => orderIdFromWebhook("REFUNDS_CREATE", { id: 123 })).toThrow();
  });

  test("concurrent duplicate receipts create one durable row and never fetch Admin", async () => {
    const { database, rows } = memoryDatabase();
    const input = { shopDomain: "one.myshopify.com", topic: "ORDERS_PAID",
      webhookId: "delivery-1", eventId: "event-1", payload: { id: 123 }, database };
    const ids = await Promise.all(Array.from({ length: 10 }, () => receiveOrderWebhook(input)));
    expect(new Set(ids).size).toBe(1);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ status: "PENDING", shopifyOrderId: "gid://shopify/Order/123" });
  });

  test("the same delivery ID is isolated between merchants", async () => {
    const { database, rows } = memoryDatabase();
    for (const shopDomain of ["one.myshopify.com", "two.myshopify.com"]) {
      await receiveOrderWebhook({ shopDomain, topic: "ORDERS_CREATE", webhookId: "same-id", payload: { id: 123 }, database });
    }
    expect(rows.size).toBe(2);
  });

  test.each([
    ["an invalid shop domain", { shopDomain: "not-a-shop" }],
    ["a missing delivery ID", { webhookId: undefined }],
    ["an unsupported topic", { topic: "ORDERS_DELETE" }],
    ["a payload without an order ID", { payload: {} }],
  ])("rejects %s as a permanent error", async (_name, overrides) => {
    const { database } = memoryDatabase();
    const input = { shopDomain: "one.myshopify.com", topic: "ORDERS_CREATE", webhookId: "delivery-1",
      payload: { id: 123 }, database, ...overrides };
    await expect(receiveOrderWebhook(input)).rejects.toBeInstanceOf(PermanentWebhookError);
    expect(database.webhookDelivery.upsert).not.toHaveBeenCalled();
  });

  test("rejects a shop with no installation record as a permanent error", async () => {
    const { database } = memoryDatabase();
    database.shop.findUnique.mockResolvedValue(null);
    await expect(receiveOrderWebhook({ shopDomain: "one.myshopify.com", topic: "ORDERS_CREATE",
      webhookId: "delivery-1", payload: { id: 123 }, database })).rejects.toBeInstanceOf(PermanentWebhookError);
  });

  test("rejects a reused delivery ID as a permanent error", async () => {
    const { database } = memoryDatabase();
    const input = { shopDomain: "one.myshopify.com", webhookId: "delivery-1", database };
    await receiveOrderWebhook({ ...input, topic: "ORDERS_CREATE", payload: { id: 123 } });
    await expect(receiveOrderWebhook({ ...input, topic: "ORDERS_CREATE", payload: { id: 456 } }))
      .rejects.toBeInstanceOf(PermanentWebhookError);
  });

  test("database failure rejects receipt so Shopify can retry", async () => {
    const { database } = memoryDatabase();
    database.webhookDelivery.upsert.mockRejectedValueOnce(new Error("database down"));
    await expect(receiveOrderWebhook({ shopDomain: "one.myshopify.com", topic: "ORDERS_CREATE",
      webhookId: "delivery-1", payload: { id: 123 }, database })).rejects.toThrow("database down");
    await expect(receiveOrderWebhook({ shopDomain: "one.myshopify.com", topic: "ORDERS_CREATE",
      webhookId: "delivery-2", payload: { id: 123 }, database })).resolves.toBeTruthy();
  });
});
