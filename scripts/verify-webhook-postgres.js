import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import prisma from "../app/db.server.js";
import { receiveOrderWebhook } from "../app/webhook-inbox.server.js";
import { claimDelivery, processNextDelivery } from "../app/webhook-worker.server.js";
import { redactShopData } from "../app/shop.server.js";

if (process.env.VERIFY_ISOLATED_DB !== "1") {
  throw new Error("Set VERIFY_ISOLATED_DB=1 only for an isolated disposable test database.");
}

const money = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" } });
const orderId = "gid://shopify/Order/9001";
const protectionLineId = "gid://shopify/LineItem/9002";
const attributes = [
  { key: "_yasas_protection_rule_id", value: "webhook-verification-rule" },
  { key: "_yasas_protection_rule_version", value: "1" },
  { key: "_yasas_protection_rate_bps", value: "25" },
  { key: "_yasas_protection_basis", value: "SHIPPABLE_PRE_DISCOUNT" },
];

function sampleOrder() {
  return {
    id: orderId, name: "#9001",
    createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:01:00Z",
    processedAt: "2026-09-23T00:00:30Z", currencyCode: "AUD", test: true,
    cancelledAt: null, displayFinancialStatus: "PAID", fullyPaid: true,
    subtotalPriceSet: money("100.25"), totalPriceSet: money("100.25"),
    totalDiscountsSet: money("0"), totalShippingPriceSet: money("0"), totalTaxSet: money("0"),
    transactionsCount: { count: 1 },
    transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS",
      createdAt: "2026-09-23T00:02:00Z", processedAt: "2026-09-23T00:02:00Z", amountSet: money("100.25") }],
    lineItems: { nodes: [
      { id: "gid://shopify/LineItem/9001", quantity: 1, requiresShipping: true,
        originalUnitPriceSet: money("120.00"), discountedTotalSet: money("100.00"),
        product: { id: "gid://shopify/Product/1" }, variant: { id: "gid://shopify/ProductVariant/1" }, customAttributes: [] },
      { id: protectionLineId, quantity: 1, requiresShipping: false,
        originalUnitPriceSet: money("0.25"), discountedTotalSet: money("0.25"),
        product: { id: "gid://shopify/Product/2" }, variant: { id: "gid://shopify/ProductVariant/2" }, customAttributes: attributes },
    ], pageInfo: { hasNextPage: false, endCursor: null } },
    refunds: [],
  };
}

const shops = [];

async function newShop() {
  const shopDomain = `verify-${randomUUID().slice(0, 8)}.myshopify.com`;
  const created = await prisma.shop.create({ data: { shopDomain } });
  shops.push(shopDomain);
  await prisma.pricingRule.create({ data: {
    shopId: created.id, ruleId: `rule-${created.id}`, version: 1,
    productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/2",
    rateBasisPoints: 25, basis: "SHIPPABLE_PRE_DISCOUNT",
    effectiveAt: new Date("2026-09-23T00:00:00Z"), state: "ACTIVE",
  } });
  return created;
}

// Counts full order fetches per order and rejects comment-only queries.
function countingAdmin() {
  const fetches = new Map();
  const admin = { graphql: async (query, { variables } = {}) => {
    if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
    const order = { ...structuredClone(sampleOrder()), id: variables.id };
    if (query.includes("query AnalyticsOrder")) fetches.set(variables.id, (fetches.get(variables.id) ?? 0) + 1);
    return { json: async () => ({ data: { order: query.includes("query OrderVersion") ? { updatedAt: order.updatedAt } : order } }) };
  } };
  return { fetches, adminForShop: async () => ({ admin }) };
}

const statuses = async (shopId) => (await prisma.webhookDelivery.findMany({
  where: { shopId }, orderBy: { webhookId: "asc" }, select: { webhookId: true, status: true, attempts: true },
}));

async function verifyCoalescing() {
  // Several webhooks for one order are handled with one Shopify fetch.
  const burst = await newShop();
  for (const [webhookId, topic] of [["b-1", "ORDERS_CREATE"], ["b-2", "ORDERS_PAID"], ["b-3", "ORDERS_UPDATED"]]) {
    await receiveOrderWebhook({ shopDomain: burst.shopDomain, topic, webhookId, payload: { id: 9101 } });
  }
  const single = countingAdmin();
  assert.equal(await processNextDelivery({ adminForShop: single.adminForShop }), true);
  assert.equal(single.fetches.get("gid://shopify/Order/9101"), 1);
  assert.deepEqual((await statuses(burst.id)).map(({ status }) => status), ["PROCESSED", "PROCESSED", "PROCESSED"]);
  assert.equal(await processNextDelivery({ adminForShop: single.adminForShop }), false);

  // A live lease on an order keeps its newer deliveries waiting for that lease.
  const leased = await newShop();
  await receiveOrderWebhook({ shopDomain: leased.shopDomain, topic: "ORDERS_CREATE", webhookId: "l-1", payload: { id: 9201 } });
  const held = await claimDelivery();
  await receiveOrderWebhook({ shopDomain: leased.shopDomain, topic: "ORDERS_PAID", webhookId: "l-2", payload: { id: 9201 } });
  assert.equal(await claimDelivery(), null);
  await prisma.webhookDelivery.updateMany({ where: { leaseToken: held.leaseToken }, data: { status: "PROCESSED", leaseToken: null, leaseUntil: null } });

  // Concurrent loops over many orders store each order exactly once.
  const busy = await newShop();
  const orderIds = [9301, 9302, 9303, 9304, 9305];
  for (const id of orderIds) {
    for (const topic of ["ORDERS_CREATE", "ORDERS_PAID", "ORDERS_UPDATED"]) {
      await receiveOrderWebhook({ shopDomain: busy.shopDomain, topic, webhookId: `c-${id}-${topic}`, payload: { id } });
    }
  }
  const concurrent = countingAdmin();
  const loop = async () => { while (await processNextDelivery({ adminForShop: concurrent.adminForShop })) { /* drain */ } };
  await Promise.all([loop(), loop(), loop(), loop()]);
  // A serialization conflict between loops is retried, so drain once more.
  await prisma.webhookDelivery.updateMany({ where: { shopId: busy.id, status: "PENDING" }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
  await loop();
  assert.ok((await statuses(busy.id)).every(({ status }) => status === "PROCESSED"));
  assert.equal(await prisma.order.count({ where: { shopId: busy.id } }), orderIds.length);
  assert.equal(await prisma.protectionPurchase.count({ where: { shopId: busy.id } }), orderIds.length);
  const totalFetches = [...concurrent.fetches.values()].reduce((sum, count) => sum + count, 0);
  assert.ok(totalFetches < orderIds.length * 3, `expected coalesced fetches, got ${totalFetches}`);

  // A lease lost mid-fetch stores nothing and returns every row to the queue.
  const lost = await newShop();
  await receiveOrderWebhook({ shopDomain: lost.shopDomain, topic: "ORDERS_CREATE", webhookId: "x-1", payload: { id: 9401 } });
  await receiveOrderWebhook({ shopDomain: lost.shopDomain, topic: "ORDERS_PAID", webhookId: "x-2", payload: { id: 9401 } });
  const expiring = countingAdmin();
  await processNextDelivery({ adminForShop: async (domain) => {
    await prisma.webhookDelivery.updateMany({ where: { shopId: lost.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    return expiring.adminForShop(domain);
  } });
  assert.deepEqual((await statuses(lost.id)).map(({ status, attempts }) => [status, attempts]), [["PENDING", 1], ["PENDING", 1]]);
  assert.equal(await prisma.order.count({ where: { shopId: lost.id } }), 0);

  // A failed batch reschedules each row by its own attempt count.
  const partial = await newShop();
  await receiveOrderWebhook({ shopDomain: partial.shopDomain, topic: "ORDERS_CREATE", webhookId: "p-1", payload: { id: 9501 } });
  await receiveOrderWebhook({ shopDomain: partial.shopDomain, topic: "ORDERS_PAID", webhookId: "p-2", payload: { id: 9501 } });
  await prisma.webhookDelivery.updateMany({ where: { shopId: partial.id, webhookId: "p-1" }, data: { attempts: 7 } });
  await processNextDelivery({ adminForShop: async () => { throw new Error("temporary Admin failure"); } });
  assert.deepEqual((await statuses(partial.id)).map(({ status, attempts }) => [status, attempts]), [["FAILED", 8], ["PENDING", 1]]);
}

try {
  const shopDomain = `verify-${randomUUID().slice(0, 8)}.myshopify.com`;
  const shop = await prisma.shop.create({ data: { shopDomain } });
  shops.push(shopDomain);
  await prisma.pricingRule.create({ data: {
    shopId: shop.id, ruleId: "webhook-verification-rule", version: 1,
    productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/2",
    rateBasisPoints: 25, basis: "SHIPPABLE_PRE_DISCOUNT",
    effectiveAt: new Date("2026-09-23T00:00:00Z"), state: "ACTIVE",
  } });
  const receipt = { shopDomain, topic: "ORDERS_PAID", webhookId: "delivery-1",
    eventId: "event-1", payload: { id: 9001 } };
  const ids = await Promise.all(Array.from({ length: 12 }, () => receiveOrderWebhook(receipt)));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await prisma.webhookDelivery.count({ where: { shopId: shop.id } }), 1);

  const claimed = await claimDelivery();
  assert.equal(claimed.shopId, shop.id);
  assert.equal(claimed.deliveries.length, 1);
  await prisma.webhookDelivery.update({ where: { id: claimed.deliveries[0].id }, data: { leaseUntil: new Date(Date.now() - 1) } });

  let currentOrder = sampleOrder();
  const admin = { graphql: async (query) => ({ json: async () => ({ data: {
    order: query.includes("query OrderVersion")
      ? { updatedAt: currentOrder.updatedAt } : structuredClone(currentOrder),
  } }) }) };
  const adminForShop = async () => ({ admin });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: claimed.deliveries[0].id } });
  assert.equal(delivery.status, "PROCESSED");
  assert.equal(delivery.attempts, 2);
  let savedOrder = await prisma.order.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: orderId } },
    include: { protectionPurchase: true },
  });
  assert.equal(savedOrder.paidMerchandiseAmount.toFixed(4), "100.0000");
  assert.equal(savedOrder.protectionPurchase.feeAmount.toFixed(4), "0.2500");
  assert.equal(savedOrder.protectionPurchase.coveredMerchandiseAmount.toFixed(4), "100.0000");
  assert.equal(savedOrder.protectionPurchase.orderValueAmount.toFixed(4), "100.2500");

  await receiveOrderWebhook({ ...receipt, topic: "ORDERS_UPDATED", webhookId: "delivery-retry" });
  assert.equal(await processNextDelivery({ adminForShop: async () => { throw new Error("temporary Admin failure"); } }), true);
  const retry = await prisma.webhookDelivery.findUnique({
    where: { shopId_webhookId: { shopId: shop.id, webhookId: "delivery-retry" } },
  });
  assert.equal(retry.status, "PENDING");
  assert.equal(retry.attempts, 1);
  await prisma.webhookDelivery.update({ where: { id: retry.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  assert.equal((await prisma.webhookDelivery.findUnique({ where: { id: retry.id } })).status, "PROCESSED");

  currentOrder.updatedAt = "2026-09-24T00:00:00Z";
  currentOrder.refunds = [{
    id: "gid://shopify/Refund/7001", processedAt: "2026-09-24T00:01:00Z",
    totalRefundedSet: money("0.25"),
    refundLineItems: { nodes: [{ lineItem: { id: protectionLineId }, subtotalSet: money("0.25") }],
      pageInfo: { hasNextPage: false, endCursor: null } },
    transactions: { nodes: [{ id: "gid://shopify/OrderTransaction/7001", kind: "REFUND", status: "SUCCESS",
      createdAt: "2026-09-24T00:02:00Z", processedAt: "2026-09-24T00:02:00Z", amountSet: money("0.25") }],
      pageInfo: { hasNextPage: false, endCursor: null } },
  }];
  await receiveOrderWebhook({ ...receipt, topic: "REFUNDS_CREATE", webhookId: "delivery-2", payload: { order_id: 9001 } });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  const refund = await prisma.protectionRefund.findUnique({
    where: { shopId_shopifyRefundId: { shopId: shop.id, shopifyRefundId: "gid://shopify/Refund/7001" } },
  });
  assert.equal(refund.status, "CONFIRMED");
  assert.equal(refund.amount.toFixed(4), "0.2500");

  currentOrder.updatedAt = "2026-09-25T00:00:00Z";
  currentOrder.cancelledAt = "2026-09-25T00:00:00Z";
  currentOrder.lineItems.nodes.pop();
  await receiveOrderWebhook({ ...receipt, topic: "ORDERS_CANCELLED", webhookId: "delivery-3" });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  savedOrder = await prisma.order.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: orderId } },
    include: { protectionPurchase: true },
  });
  assert.equal(savedOrder.paidMerchandiseAmount.toFixed(4), "100.0000");
  assert.equal(savedOrder.protectionPurchase.feeAmount.toFixed(4), "0.2500");
  assert.equal(await prisma.protectionPurchase.count({ where: { shopId: shop.id } }), 1);

  const secondDomain = `verify-${randomUUID().slice(0, 8)}.myshopify.com`;
  const secondShop = await prisma.shop.create({ data: { shopDomain: secondDomain } });
  shops.push(secondDomain);
  await prisma.shop.update({ where: { id: secondShop.id }, data: { installationState: "UNINSTALLED" } });
  await receiveOrderWebhook({ ...receipt, shopDomain: secondDomain });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  const reinstallDelivery = await prisma.webhookDelivery.findUnique({
    where: { shopId_webhookId: { shopId: secondShop.id, webhookId: receipt.webhookId } },
  });
  assert.equal(reinstallDelivery.status, "PENDING");
  await prisma.shop.update({ where: { id: secondShop.id }, data: { installationState: "INSTALLED" } });
  await prisma.webhookDelivery.update({ where: { id: reinstallDelivery.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  assert.equal(await prisma.order.count({ where: { shopId: secondShop.id, shopifyOrderId: orderId } }), 1);
  assert.equal(await prisma.order.count({ where: { shopId: shop.id, shopifyOrderId: orderId } }), 1);
  await verifyCoalescing();
  console.log("PostgreSQL webhook verification passed: duplicate receipt, crash recovery, paid snapshots, refunds, tenant isolation, and coalesced concurrent processing.");
} finally {
  for (const shopDomain of shops) {
    await prisma.$transaction((tx) => redactShopData(tx, shopDomain));
  }
  await prisma.$disconnect();
}
