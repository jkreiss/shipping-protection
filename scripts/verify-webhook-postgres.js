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
    id: orderId, name: "#9001", checkoutToken: null,
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
  await prisma.webhookDelivery.update({ where: { id: claimed.id }, data: { leaseUntil: new Date(Date.now() - 1) } });

  let currentOrder = sampleOrder();
  const admin = { graphql: async (query) => ({ json: async () => ({ data: {
    order: query.includes("query OrderVersion")
      ? { updatedAt: currentOrder.updatedAt } : structuredClone(currentOrder),
  } }) }) };
  const adminForShop = async () => ({ admin });
  assert.equal(await processNextDelivery({ adminForShop }), true);
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: claimed.id } });
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
  console.log("PostgreSQL webhook verification passed: duplicate receipt, crash recovery, paid snapshots, refunds, and tenant isolation.");
} finally {
  for (const shopDomain of shops) {
    await prisma.$transaction((tx) => redactShopData(tx, shopDomain));
  }
  await prisma.$disconnect();
}
