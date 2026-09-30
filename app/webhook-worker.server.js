import { randomUUID } from "node:crypto";
import prisma from "./db.server.js";
import { fetchShopifyOrder } from "./order-shopify.server.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { persistNormalizedOrder } from "./order-ingestion.server.js";
import { failureCode, logEvent, reportFailure } from "./observability.server.js";
import { retrySerializationFailures } from "./serializable-retry.server.js";

export const MAX_DELIVERY_ATTEMPTS = 8;

export const DEFAULT_WORKER_CONCURRENCY = 4;
const MAX_WORKER_CONCURRENCY = 16;

// Delivery loops the worker runs in parallel. Each needs a database
// connection while it persists, so keep Prisma's connection_limit above it.
export function workerConcurrency(value) {
  if (value === undefined || value === "") return DEFAULT_WORKER_CONCURRENCY;
  const count = Number(value);
  if (!/^\d+$/.test(value) || count < 1 || count > MAX_WORKER_CONCURRENCY) {
    throw new RangeError(`WORKER_CONCURRENCY must be a whole number from 1 to ${MAX_WORKER_CONCURRENCY}.`);
  }
  return count;
}

export function retryDelayMs(attempts) {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

const MAX_BATCH_DELIVERIES = 100;

// Claims every queued delivery for one order under a single lease, so one
// Shopify fetch covers them all. Orders that already have a live lease are
// skipped. SKIP LOCKED keeps concurrent workers from blocking or deadlocking;
// if two workers still pick the same order, persistence is idempotent.
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
    WITH candidate AS (
      SELECT d."shopId", d."shopifyOrderId" FROM "WebhookDelivery" d
      WHERE d."attempts" < ${MAX_DELIVERY_ATTEMPTS}
        AND ((d."status" = 'PENDING'::"WebhookProcessingStatus" AND d."nextAttemptAt" <= NOW())
          OR (d."status" = 'PROCESSING'::"WebhookProcessingStatus" AND d."leaseUntil" <= NOW()))
        AND NOT EXISTS (
          SELECT 1 FROM "WebhookDelivery" live
          WHERE live."shopId" = d."shopId" AND live."shopifyOrderId" = d."shopifyOrderId"
            AND live."status" = 'PROCESSING'::"WebhookProcessingStatus" AND live."leaseUntil" > NOW())
      ORDER BY d."nextAttemptAt", d."receivedAt", d.id
      FOR UPDATE SKIP LOCKED LIMIT 1
    ), batch AS (
      SELECT d.id FROM "WebhookDelivery" d JOIN candidate c
        ON d."shopId" = c."shopId" AND d."shopifyOrderId" = c."shopifyOrderId"
      WHERE d."attempts" < ${MAX_DELIVERY_ATTEMPTS}
        AND (d."status" = 'PENDING'::"WebhookProcessingStatus"
          OR (d."status" = 'PROCESSING'::"WebhookProcessingStatus" AND d."leaseUntil" <= NOW()))
      ORDER BY d."receivedAt", d.id
      LIMIT ${MAX_BATCH_DELIVERIES}
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE "WebhookDelivery" SET "status" = 'PROCESSING'::"WebhookProcessingStatus",
      "attempts" = "attempts" + 1, "leaseToken" = ${leaseToken},
      "leaseUntil" = NOW() + INTERVAL '15 minutes', "updatedAt" = NOW()
    WHERE id IN (SELECT id FROM batch)
    RETURNING id, "shopId", "shopifyOrderId", topic, attempts`;
  if (rows.length === 0) return null;
  return {
    shopId: rows[0].shopId,
    shopifyOrderId: rows[0].shopifyOrderId,
    leaseToken,
    deliveries: rows.map(({ id, topic, attempts }) => ({ id, topic, attempts })),
  };
}

export async function processNextDelivery({
  database = prisma,
  claim = claimDelivery,
  adminForShop = async (shop) => (await import("./shopify.server.js")).unauthenticated.admin(shop),
  hashSecret = process.env.CHECKOUT_TOKEN_HASH_SECRET,
} = {}) {
  const batch = await claim(database);
  if (!batch) return false;
  const started = Date.now();
  const { leaseToken, shopId } = batch;
  const context = {
    deliveryIds: batch.deliveries.map(({ id }) => id), shopId,
    topics: [...new Set(batch.deliveries.map(({ topic }) => topic))],
  };
  try {
    const shop = await database.shop.findUnique({ where: { id: shopId }, select: { id: true, shopDomain: true, installationState: true } });
    if (!shop || shop.installationState !== "INSTALLED") {
      throw new Error("Shop is not installed.");
    }
    const { admin } = await adminForShop(shop.shopDomain);
    const order = await fetchShopifyOrder(admin, batch.shopifyOrderId, { shop: shop.shopDomain });
    const normalized = normalizeGraphqlOrder(order, hashSecret);
    // Look rows up by primary key so the Serializable check locks only this batch.
    const ids = context.deliveryIds;
    await retrySerializationFailures(() => database.$transaction(async (transaction) => {
      const leased = await transaction.webhookDelivery.count({
        where: { id: { in: ids }, shopId: shop.id, leaseToken, status: "PROCESSING", leaseUntil: { gt: new Date() } },
      });
      if (leased !== batch.deliveries.length) throw new Error("Webhook lease expired.");
      await persistNormalizedOrder(transaction, shop, normalized);
      const completion = await transaction.webhookDelivery.updateMany({
        where: { id: { in: ids }, shopId: shop.id, leaseToken, status: "PROCESSING", leaseUntil: { gt: new Date() } },
        data: { status: "PROCESSED", processedAt: new Date(), leaseToken: null, leaseUntil: null, errorMessage: null },
      });
      if (completion.count !== batch.deliveries.length) throw new Error("Webhook lease was lost before completion.");
    }, { isolationLevel: "Serializable", timeout: 30_000 }));
    logEvent("webhook_processed", { ...context, durationMs: Date.now() - started });
  } catch (error) {
    if (error?.code === "P2034") {
      // Concurrent work on the same shop, not a problem with these deliveries:
      // requeue soon and give back the attempt the claim spent.
      await database.webhookDelivery.updateMany({
        where: { shopId, leaseToken, status: "PROCESSING" },
        data: {
          status: "PENDING", attempts: { decrement: 1 },
          nextAttemptAt: new Date(Date.now() + 1_000 + Math.floor(Math.random() * 2_000)),
          leaseToken: null, leaseUntil: null, errorMessage: "P2034",
        },
      });
      logEvent("webhook_conflict_requeued", { ...context, durationMs: Date.now() - started });
      return true;
    }
    // Each delivery keeps its own attempt count, so reschedule them one by one.
    for (const delivery of batch.deliveries) {
      const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
      await database.webhookDelivery.updateMany({
        where: { id: delivery.id, shopId, leaseToken, status: "PROCESSING" },
        data: {
          status: terminal ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(Date.now() + retryDelayMs(delivery.attempts)),
          failedAt: terminal ? new Date() : null,
          leaseToken: null, leaseUntil: null,
          errorMessage: failureCode(error),
        },
      });
      reportFailure(terminal ? "webhook_terminal" : "webhook_retry", error, {
        deliveryId: delivery.id, shopId, topic: delivery.topic,
        attempts: delivery.attempts, durationMs: Date.now() - started,
      });
    }
  }
  return true;
}
