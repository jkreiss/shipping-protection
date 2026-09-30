import { randomUUID } from "node:crypto";
import prisma from "./db.server.js";
import { fetchShopifyOrder } from "./order-shopify.server.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { persistNormalizedOrder } from "./order-ingestion.server.js";
import { failureCode, logEvent, reportFailure } from "./observability.server.js";

export const MAX_DELIVERY_ATTEMPTS = 8;

export function retryDelayMs(attempts) {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export async function claimDelivery(database = prisma) {
  const expired = await database.$queryRaw`
    UPDATE "WebhookDelivery" SET "status" = 'FAILED'::"WebhookProcessingStatus",
      "failedAt" = NOW(), "leaseToken" = NULL, "leaseUntil" = NULL,
      "errorMessage" = 'LEASE_EXPIRED'
    WHERE "status" = 'PROCESSING'::"WebhookProcessingStatus"
      AND "leaseUntil" <= NOW() AND "attempts" >= ${MAX_DELIVERY_ATTEMPTS}
    RETURNING id, "shopId", topic`;
  for (const delivery of expired) {
    reportFailure("webhook_terminal", new Error("LEASE_EXPIRED"), {
      deliveryId: delivery.id, shopId: delivery.shopId, topic: delivery.topic,
    });
  }
  const leaseToken = randomUUID();
  const rows = await database.$queryRaw`
    UPDATE "WebhookDelivery" SET "status" = 'PROCESSING'::"WebhookProcessingStatus",
      "attempts" = "attempts" + 1, "leaseToken" = ${leaseToken},
      "leaseUntil" = NOW() + INTERVAL '15 minutes', "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "WebhookDelivery"
      WHERE "attempts" < ${MAX_DELIVERY_ATTEMPTS}
        AND (("status" = 'PENDING'::"WebhookProcessingStatus" AND "nextAttemptAt" <= NOW())
          OR ("status" = 'PROCESSING'::"WebhookProcessingStatus" AND "leaseUntil" <= NOW()))
      ORDER BY "nextAttemptAt", "receivedAt", id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, "shopId", "shopifyOrderId", topic, attempts, "leaseToken"`;
  return rows[0] ?? null;
}

export async function processNextDelivery({
  database = prisma,
  claim = claimDelivery,
  adminForShop = async (shop) => (await import("./shopify.server.js")).unauthenticated.admin(shop),
  hashSecret = process.env.CHECKOUT_TOKEN_HASH_SECRET,
} = {}) {
  const delivery = await claim(database);
  if (!delivery) return false;
  const started = Date.now();
  try {
    const shop = await database.shop.findUnique({ where: { id: delivery.shopId }, select: { id: true, shopDomain: true, installationState: true } });
    if (!shop || shop.installationState !== "INSTALLED") {
      throw new Error("Shop is not installed.");
    }
    const { admin } = await adminForShop(shop.shopDomain);
    const order = await fetchShopifyOrder(admin, delivery.shopifyOrderId, { shop: shop.shopDomain });
    const normalized = normalizeGraphqlOrder(order, hashSecret);
    await database.$transaction(async (transaction) => {
      const lease = await transaction.webhookDelivery.findFirst({
        where: { id: delivery.id, shopId: shop.id, leaseToken: delivery.leaseToken, status: "PROCESSING" },
      });
      if (!lease || lease.leaseUntil <= new Date()) throw new Error("Webhook lease expired.");
      await persistNormalizedOrder(transaction, shop, normalized);
      const completion = await transaction.webhookDelivery.updateMany({
        where: { id: delivery.id, shopId: shop.id, leaseToken: delivery.leaseToken,
          status: "PROCESSING", leaseUntil: { gt: new Date() } },
        data: { status: "PROCESSED", processedAt: new Date(), leaseToken: null, leaseUntil: null, errorMessage: null },
      });
      if (completion.count !== 1) throw new Error("Webhook lease was lost before completion.");
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    logEvent("webhook_processed", { deliveryId: delivery.id, shopId: shop.id,
      topic: delivery.topic, attempts: delivery.attempts, durationMs: Date.now() - started });
  } catch (error) {
    const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    await database.webhookDelivery.updateMany({
      where: { id: delivery.id, shopId: delivery.shopId, leaseToken: delivery.leaseToken, status: "PROCESSING" },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        nextAttemptAt: new Date(Date.now() + retryDelayMs(delivery.attempts)),
        failedAt: terminal ? new Date() : null,
        leaseToken: null, leaseUntil: null,
        errorMessage: failureCode(error),
      },
    });
    reportFailure(terminal ? "webhook_terminal" : "webhook_retry", error, {
      deliveryId: delivery.id, shopId: delivery.shopId, topic: delivery.topic,
      attempts: delivery.attempts, durationMs: Date.now() - started,
    });
  }
  return true;
}
