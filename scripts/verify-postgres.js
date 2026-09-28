import assert from "node:assert/strict";
import prisma from "../app/db.server.js";
import { persistNormalizedOrder } from "../app/order-ingestion.server.js";
import { normalizeGraphqlOrder } from "../app/order-normalization.js";
import { reconcileOrders } from "../app/order-reconciliation.server.js";

const rollback = new Error("POSTGRES_VERIFICATION_ROLLBACK");
const timestamp = new Date("2026-09-23T00:00:00.000Z");
const shopMoney = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" } });

function graphqlOrder(id, protectedOrder) {
  const protectionAttributes = [
    { key: "_yasas_protection_rule_id", value: "postgres-verification-rule" },
    { key: "_yasas_protection_rule_version", value: "1" },
    { key: "_yasas_protection_rate_bps", value: "25" },
    { key: "_yasas_protection_basis", value: "SHIPPABLE_PRE_DISCOUNT" },
  ];
  const lines = [{
    id: `${id}/LineItem/1`, quantity: 1, requiresShipping: true,
    originalUnitPriceSet: shopMoney("100.00"), discountedTotalSet: shopMoney("100.00"),
    product: { id: "gid://shopify/Product/1" }, variant: { id: "gid://shopify/ProductVariant/1" }, customAttributes: [],
  }];
  if (protectedOrder) lines.push({
    id: `${id}/LineItem/2`, quantity: 1, requiresShipping: false,
    originalUnitPriceSet: shopMoney("0.25"), discountedTotalSet: shopMoney("0.25"),
    product: { id: "gid://shopify/Product/9" }, variant: { id: "gid://shopify/ProductVariant/10" },
    customAttributes: protectionAttributes,
  });
  const total = protectedOrder ? "100.25" : "100.00";
  return {
    id, name: id.endsWith("9001") ? "#9001" : "#9002", checkoutToken: null,
    createdAt: timestamp.toISOString(), updatedAt: "2026-09-23T01:00:00Z",
    processedAt: timestamp.toISOString(), currencyCode: "AUD", test: true,
    cancelledAt: null, displayFinancialStatus: "PAID", fullyPaid: true,
    subtotalPriceSet: shopMoney(total), totalPriceSet: shopMoney(total),
    totalDiscountsSet: shopMoney("0"), totalShippingPriceSet: shopMoney("0"), totalTaxSet: shopMoney("0"),
    transactions: [{ id: `${id}/Transaction/1`, kind: "SALE", status: "SUCCESS",
      createdAt: "2026-09-23T02:00:00Z", processedAt: "2026-09-23T02:00:00Z", amountSet: shopMoney(total) }],
    lineItems: { nodes: lines, pageInfo: { hasNextPage: false } },
    refunds: protectedOrder ? [{
      id: "gid://shopify/Refund/777", processedAt: "2026-09-23T03:00:00Z",
      totalRefundedSet: shopMoney("0.25"),
      refundLineItems: { nodes: [{ lineItem: { id: `${id}/LineItem/2` }, subtotalSet: shopMoney("0.25") }], pageInfo: { hasNextPage: false } },
      transactions: { nodes: [{ id: `${id}/Transaction/2`, kind: "REFUND", status: "SUCCESS",
        createdAt: "2026-09-23T03:00:00Z", processedAt: "2026-09-23T03:00:00Z", amountSet: shopMoney("0.25") }], pageInfo: { hasNextPage: false } },
    }] : [],
  };
}

function normalizedOrder({ id, name, protectedOrder }) {
  const lines = [
    {
      shopifyLineItemId: `${id}/LineItem/1`,
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      quantity: 1,
      requiresShipping: true,
      currencyCode: "AUD",
      originalUnitAmount: "100.0000",
      preDiscountAmount: "100.0000",
      totalDiscountAmount: "0.0000",
      finalAmount: "100.0000",
      protectionAttributes: {},
    },
  ];

  if (protectedOrder) {
    lines.push({
      shopifyLineItemId: `${id}/LineItem/2`,
      productId: "gid://shopify/Product/9",
      variantId: "gid://shopify/ProductVariant/10",
      quantity: 1,
      requiresShipping: false,
      currencyCode: "AUD",
      originalUnitAmount: "0.2500",
      preDiscountAmount: "0.2500",
      totalDiscountAmount: "0.0000",
      finalAmount: "0.2500",
      protectionAttributes: {
        _yasas_protection_rule_id: "postgres-verification-rule",
        _yasas_protection_rule_version: "1",
        _yasas_protection_rate_bps: "25",
        _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      },
    });
  }

  return {
    shopifyOrderId: id,
    name,
    checkoutTokenHash: null,
    shopifyCreatedAt: timestamp,
    shopifyUpdatedAt: timestamp,
    processedAt: timestamp,
    currencyCode: "AUD",
    subtotalAmount: protectedOrder ? "100.2500" : "100.0000",
    totalAmount: protectedOrder ? "100.2500" : "100.0000",
    totalDiscountsAmount: "0.0000",
    totalShippingAmount: "0.0000",
    totalTaxAmount: "0.0000",
    lines,
  };
}

try {
  await prisma.$transaction(async (transaction) => {
    const shop = await transaction.shop.create({
      data: { shopDomain: "postgres-verification.invalid" },
    });
    const rule = await transaction.pricingRule.create({
      data: {
        shopId: shop.id,
        ruleId: "postgres-verification-rule",
        version: 1,
        productId: "gid://shopify/Product/9",
        variantId: "gid://shopify/ProductVariant/10",
        rateBasisPoints: 25,
        basis: "SHIPPABLE_PRE_DISCOUNT",
        state: "ACTIVE",
        effectiveAt: timestamp,
        publishedAt: timestamp,
        activatedAt: timestamp,
      },
    });
    await transaction.shop.update({
      where: { id: shop.id },
      data: { activePricingRuleId: rule.id },
    });

    const protectedOrder = normalizedOrder({
      id: "gid://shopify/Order/9001",
      name: "#9001",
      protectedOrder: true,
    });
    await persistNormalizedOrder(transaction, shop, protectedOrder);
    await persistNormalizedOrder(transaction, shop, protectedOrder);
    await persistNormalizedOrder(
      transaction,
      shop,
      normalizedOrder({
        id: "gid://shopify/Order/9002",
        name: "#9002",
        protectedOrder: false,
      }),
    );

    const orders = await transaction.order.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      include: { lines: true, protectionPurchase: true },
    });
    assert.equal(orders.length, 2);
    assert.equal(orders[0].lines.length, 2);
    assert.equal(orders[0].protectionPurchase?.attributionStatus, "ATTRIBUTED");
    assert.equal(
      orders[0].protectionPurchase?.eligibleSubtotalAmount.toFixed(4),
      "100.0000",
    );
    assert.equal(orders[0].protectionPurchase?.feeAmount.toFixed(4), "0.2500");
    assert.equal(orders[1].lines.length, 1);
    assert.equal(orders[1].protectionPurchase, null);

    const admin = { graphql: async (query, { variables }) => {
      if (query.includes("query ReconcileOrders")) {
        const first = !variables.after;
        return { json: async () => ({ data: { orders: {
          nodes: [{ id: `gid://shopify/Order/${first ? "9001" : "9002"}` }],
          pageInfo: { hasNextPage: first, endCursor: first ? "page-one" : null },
        } } }) };
      }
      const id = variables.id;
      return { json: async () => ({ data: { order: graphqlOrder(id, id.endsWith("9001")) } }) };
    } };
    const database = { shop: transaction.shop, protectionRefund: transaction.protectionRefund,
      $transaction: (callback) => callback(transaction) };
    const firstBatch = await reconcileOrders({ admin, shopDomain: shop.shopDomain, database, maxPages: 1, pageSize: 1 });
    assert.equal(firstBatch.complete, false);
    assert.equal((await transaction.shop.findUnique({ where: { id: shop.id } })).orderReconciliationCursor, "page-one");
    const secondBatch = await reconcileOrders({ admin, shopDomain: shop.shopDomain, database, maxPages: 1, pageSize: 1 });
    assert.equal(secondBatch.complete, true);
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 2);
    const paidOrder = await transaction.order.findUnique({
      where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: "gid://shopify/Order/9001" } },
    });
    assert.equal(paidOrder.paidProtectionFee.toFixed(4), "0.2500");
    assert.equal(paidOrder.paidEligible, true);
    await persistNormalizedOrder(transaction, shop, normalizeGraphqlOrder(graphqlOrder("gid://shopify/Order/9001", true)));
    assert.equal(await transaction.protectionRefund.count({ where: { shopId: shop.id } }), 1);
    assert.equal((await transaction.protectionRefund.findFirst({ where: { shopId: shop.id } })).status, "CONFIRMED");

    const otherShop = await transaction.shop.create({ data: { shopDomain: "postgres-verification-other.invalid" } });
    const otherOrder = await persistNormalizedOrder(transaction, otherShop, normalizedOrder({
      id: "gid://shopify/Order/9001", name: "#9001", protectedOrder: false,
    }));
    await transaction.protectionRefund.create({ data: {
      shopId: otherShop.id, orderId: otherOrder.id, shopifyRefundId: "gid://shopify/Refund/777",
      status: "PENDING", amount: "0.0000", currencyCode: "AUD",
    } });
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 2);
    assert.equal(await transaction.order.count({ where: { shopId: otherShop.id } }), 1);
    assert.equal(await transaction.protectionRefund.count({ where: { shopId: shop.id } }), 1);
    assert.equal(await transaction.protectionRefund.count({ where: { shopId: otherShop.id } }), 1);

    throw rollback;
  }, { timeout: 60_000 });
} catch (error) {
  if (error !== rollback) throw error;
  assert.equal(
    await prisma.shop.count({
      where: { shopDomain: "postgres-verification.invalid" },
    }),
    0,
  );
} finally {
  await prisma.$disconnect();
}

console.log(
  "PostgreSQL verification passed: paid snapshots, resumable reconciliation, refund deduplication, and tenant isolation.",
);
