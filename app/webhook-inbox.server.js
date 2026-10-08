import prisma from "./db.server.js";

export const ORDER_TOPICS = new Set([
  "ORDERS_CREATE", "ORDERS_PAID", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE",
]);

// A delivery that can never be stored, however often Shopify resends it. The
// route acknowledges these instead of asking for a retry; reconciliation
// backfills the order if it is real. Database and other errors stay plain Errors.
export class PermanentWebhookError extends Error {
  name = "PermanentWebhookError";
}

export function orderIdFromWebhook(topic, payload) {
  if (!ORDER_TOPICS.has(topic)) throw new PermanentWebhookError("Unsupported order webhook topic.");
  const value = topic === "REFUNDS_CREATE" ? payload?.order_id : payload?.admin_graphql_api_id ?? payload?.id;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new PermanentWebhookError("Order webhook ID cannot be represented safely.");
  }
  const id = String(value ?? "");
  if (/^[1-9]\d*$/.test(id)) return `gid://shopify/Order/${id}`;
  if (/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(id)) return id;
  throw new PermanentWebhookError("Order webhook has no valid Shopify order ID.");
}

export async function receiveOrderWebhook({ shopDomain, topic, payload, webhookId, eventId, database = prisma }) {
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shopDomain ?? "")) {
    throw new PermanentWebhookError("Invalid Shopify shop domain.");
  }
  if (typeof webhookId !== "string" || webhookId.length < 1 || webhookId.length > 255) {
    throw new PermanentWebhookError("Missing Shopify webhook delivery ID.");
  }
  const shopifyOrderId = orderIdFromWebhook(topic, payload);
  const shop = await database.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) {
    throw new PermanentWebhookError("Webhook shop has no installation record.");
  }
  const key = { shopId: shop.id, webhookId };
  let delivery;
  try {
    delivery = await database.webhookDelivery.upsert({
      where: { shopId_webhookId: key },
      create: { ...key, eventId: eventId || null, topic, shopifyOrderId, status: "PENDING" },
      update: {},
      select: { id: true, shopifyOrderId: true, topic: true },
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    delivery = await database.webhookDelivery.findUnique({
      where: { shopId_webhookId: key }, select: { id: true, shopifyOrderId: true, topic: true },
    });
    if (!delivery) throw error;
  }
  if (delivery.shopifyOrderId !== shopifyOrderId || delivery.topic !== topic) {
    throw new PermanentWebhookError("Webhook delivery ID was reused for a different event.");
  }
  return delivery.id;
}

export const RECONCILE_TOPIC = "RECONCILE";
const REFRESH_DELAY_MS = 60_000;

// Hands an order to the worker to fetch again, with retries and backoff like a
// webhook delivery: one that reconciliation could not store, or one stored from
// two different copies in the same second. Keyed by reason and order version,
// so the same version is queued only once.
export async function queueOrderRefresh({ shopId, shopifyOrderId, version, reason = "reconcile", database = prisma }) {
  const webhookId = `${reason}:${shopifyOrderId}:${version}`;
  await database.webhookDelivery.upsert({
    where: { shopId_webhookId: { shopId, webhookId } },
    create: {
      shopId, webhookId, topic: RECONCILE_TOPIC, shopifyOrderId, status: "PENDING",
      nextAttemptAt: new Date(Date.now() + REFRESH_DELAY_MS),
    },
    update: {},
    select: { id: true },
  });
}
