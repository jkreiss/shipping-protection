import assert from "node:assert/strict";
import prisma from "../app/db.server.js";
import { persistNormalizedOrder } from "../app/order-ingestion.server.js";
import { normalizeGraphqlOrder } from "../app/order-normalization.js";
import { reconcileOrders } from "../app/order-reconciliation.server.js";
import { purgeExpiredOrderBatch } from "../app/order-retention.server.js";
import { redactCustomerOrders, redactShopData } from "../app/shop.server.js";

const rollback = new Error("POSTGRES_VERIFICATION_ROLLBACK");
const timestamp = new Date("2026-09-23T00:00:00.000Z");
// Orders are placed now, so the 24-month retention ceiling never skips them.
const orderCreatedAt = new Date();
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
    id, name: id.endsWith("9001") ? "#9001" : "#9002",
    createdAt: orderCreatedAt.toISOString(), updatedAt: "2026-09-23T01:00:00Z",
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
    shopifyCreatedAt: orderCreatedAt,
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
      data: { activePricingRuleId: rule.id, activePricingRuleShopId: shop.id },
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
    assert.equal(orders[0].protectionPurchase?.shopId, shop.id);
    assert.equal(
      orders[0].protectionPurchase?.eligibleSubtotalAmount.toFixed(4),
      "100.0000",
    );
    assert.equal(orders[0].protectionPurchase?.feeAmount.toFixed(4), "0.2500");
    assert.equal(orders[0].protectionPurchase?.purchasedAt, null);
    assert.equal(orders[0].lines.every((line) => line.shopId === shop.id), true);
    assert.equal(orders[1].lines.length, 1);
    assert.equal(orders[1].protectionPurchase, null);

    const admin = { graphql: async (query, { variables }) => {
      if (query.includes("query ReconcileOrders")) {
        const first = !variables.after;
        return { json: async () => ({ data: { orders: {
          nodes: [{ id: `gid://shopify/Order/${first ? "9001" : "9002"}`,
            updatedAt: graphqlOrder(`gid://shopify/Order/${first ? "9001" : "9002"}`, first).updatedAt }],
          pageInfo: { hasNextPage: first, endCursor: first ? "page-one" : null },
        } } }) };
      }
      const id = variables.id;
      return { json: async () => ({ data: { order: graphqlOrder(id, id.endsWith("9001")) } }) };
    } };
    const database = { shop: transaction.shop, order: transaction.order, protectionRefund: transaction.protectionRefund,
      $transaction: (callback) => callback(transaction) };
    const firstBatch = await reconcileOrders({ admin, shopDomain: shop.shopDomain, database, maxPages: 1, pageSize: 1 });
    assert.equal(firstBatch.complete, false);
    assert.equal((await transaction.shop.findUnique({ where: { id: shop.id } })).orderReconciliationCursor, "page-one");
    const secondBatch = await reconcileOrders({ admin, shopDomain: shop.shopDomain, database, maxPages: 1, pageSize: 1 });
    assert.equal(secondBatch.complete, true);
    // The next window lists the same unchanged orders and fetches none of them.
    const unchanged = await reconcileOrders({ admin, shopDomain: shop.shopDomain, database, pageSize: 1 });
    assert.equal(unchanged.complete, true);
    assert.equal(unchanged.ordersListed, 2);
    assert.equal(unchanged.ordersFetched, 0);
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 2);
    const paidOrder = await transaction.order.findUnique({
      where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: "gid://shopify/Order/9001" } },
    });
    assert.equal(paidOrder.paidProtectionFee.toFixed(4), "0.2500");
    assert.equal(paidOrder.paidMerchandiseAmount.toFixed(4), "100.0000");
    assert.equal(paidOrder.paidEligible, true);
    const paidPurchase = await transaction.protectionPurchase.findUnique({
      where: { orderId_shopId: { orderId: paidOrder.id, shopId: shop.id } },
    });
    assert.equal(paidPurchase.purchasedAt.toISOString(), "2026-09-23T02:00:00.000Z");
    assert.equal(paidPurchase.coveredMerchandiseAmount.toFixed(4), "100.0000");
    assert.equal(paidPurchase.orderValueAmount.toFixed(4), "100.2500");
    assert.deepEqual(paidPurchase.protectionLineIds, ["gid://shopify/Order/9001/LineItem/2"]);
    await persistNormalizedOrder(transaction, shop, normalizeGraphqlOrder(graphqlOrder("gid://shopify/Order/9001", true)));
    assert.equal(await transaction.protectionRefund.count({ where: { shopId: shop.id } }), 1);
    assert.equal((await transaction.protectionRefund.findFirst({ where: { shopId: shop.id } })).status, "CONFIRMED");

    const edited = normalizedOrder({ id: "gid://shopify/Order/9001", name: "#9001", protectedOrder: false });
    edited.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
    edited.refunds = graphqlOrder("gid://shopify/Order/9001", true).refunds;
    await persistNormalizedOrder(transaction, shop, edited);
    const afterEdit = await transaction.protectionPurchase.findUnique({
      where: { orderId_shopId: { orderId: paidOrder.id, shopId: shop.id } },
    });
    assert.equal(afterEdit.id, paidPurchase.id);
    assert.equal(afterEdit.feeAmount.toFixed(4), "0.2500");
    assert.deepEqual(afterEdit.protectionLineIds, paidPurchase.protectionLineIds);
    assert.equal((await transaction.order.findUnique({ where: { id: paidOrder.id } })).paidProtected, true);
    assert.equal((await transaction.protectionRefund.findFirst({ where: { shopId: shop.id } })).status, "CONFIRMED");

    const otherShop = await transaction.shop.create({ data: { shopDomain: "postgres-verification-other.invalid" } });
    const otherOrder = await persistNormalizedOrder(transaction, otherShop, normalizedOrder({
      id: "gid://shopify/Order/9001", name: "#9001", protectedOrder: false,
    }));
    await transaction.pricingRule.create({ data: {
      shopId: otherShop.id, ruleId: rule.ruleId, version: 1,
      productId: rule.productId, variantId: rule.variantId,
      rateBasisPoints: 25, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: timestamp,
    } });
    await transaction.protectionRefund.create({ data: {
      shopId: otherShop.id, orderId: otherOrder.id, shopifyRefundId: "gid://shopify/Refund/777",
      status: "PENDING", amount: "0.0000", currencyCode: "AUD",
    } });
    await transaction.$executeRawUnsafe('SAVEPOINT purchase_tenant_check');
    await assert.rejects(transaction.protectionPurchase.create({ data: {
      shopId: shop.id, orderId: otherOrder.id, currencyCode: "AUD",
      eligibleSubtotalAmount: "100.0000", feeAmount: "0.2500",
      attributionStatus: "UNATTRIBUTED",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT purchase_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT purchase_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT rule_tenant_check');
    await assert.rejects(transaction.protectionPurchase.create({ data: {
      shopId: otherShop.id, orderId: otherOrder.id, pricingRuleId: rule.id,
      currencyCode: "AUD", feeAmount: "0.2500", attributionStatus: "UNATTRIBUTED",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rule_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT rule_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT line_tenant_check');
    await assert.rejects(transaction.orderLine.create({ data: {
      shopId: shop.id, orderId: otherOrder.id, shopifyLineItemId: "gid://shopify/LineItem/cross-shop",
      quantity: 1, requiresShipping: true, currencyCode: "AUD",
      originalUnitAmount: "1.0000", preDiscountAmount: "1.0000",
      totalDiscountAmount: "0.0000", finalAmount: "1.0000",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT line_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT line_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT active_rule_tenant_check');
    await assert.rejects(transaction.shop.update({
      where: { id: otherShop.id },
      data: { activePricingRuleId: rule.id, activePricingRuleShopId: otherShop.id },
    }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT active_rule_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT active_rule_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT refund_tenant_check');
    await assert.rejects(transaction.protectionRefund.create({ data: {
      shopId: shop.id, orderId: otherOrder.id,
      shopifyRefundId: "gid://shopify/Refund/778", status: "PENDING",
      amount: "0.0000", currencyCode: "AUD",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refund_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT refund_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT paid_purchase_immutable_check');
    await assert.rejects(transaction.protectionPurchase.update({
      where: { id: paidPurchase.id }, data: { feeAmount: "1.0000" },
    }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT paid_purchase_immutable_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT paid_purchase_immutable_check');
    await transaction.$executeRawUnsafe('SAVEPOINT paid_order_immutable_check');
    await assert.rejects(transaction.order.update({
      where: { id: paidOrder.id }, data: { paidMerchandiseAmount: "999.0000" },
    }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT paid_order_immutable_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT paid_order_immutable_check');
    const provisional = await transaction.protectionPurchase.create({ data: {
      shopId: otherShop.id, orderId: otherOrder.id, currencyCode: "AUD",
      eligibleSubtotalAmount: "100.0000", feeAmount: "0.2500",
      attributionStatus: "UNATTRIBUTED",
    } });
    await transaction.$executeRawUnsafe('SAVEPOINT provisional_claim_check');
    await assert.rejects(transaction.claim.create({ data: {
      shopId: otherShop.id, protectionPurchaseId: provisional.id, type: "LOST",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT provisional_claim_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT provisional_claim_check');
    const claim = await transaction.claim.create({ data: {
      shopId: shop.id, protectionPurchaseId: paidPurchase.id, type: "LOST",
    } });
    await transaction.claimEvent.create({ data: {
      shopId: shop.id, claimId: claim.id, type: "SUBMITTED",
    } });
    assert.equal(await transaction.claimEvent.count({ where: { shopId: shop.id, claimId: claim.id } }), 1);
    await transaction.$executeRawUnsafe('SAVEPOINT claim_tenant_check');
    await assert.rejects(transaction.claim.create({ data: {
      shopId: otherShop.id, protectionPurchaseId: paidPurchase.id, type: "LOST",
    } }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT claim_tenant_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT claim_tenant_check');
    await transaction.$executeRawUnsafe('SAVEPOINT event_append_check');
    await assert.rejects(transaction.claimEvent.updateMany({
      where: { shopId: shop.id, claimId: claim.id }, data: { reason: "changed" },
    }));
    await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT event_append_check');
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT event_append_check');
    // The retention purge deletes an order placed before its cutoff, including a
    // confirmed purchase and append-only claim events, and keeps newer orders.
    const expiredAt = new Date("2024-01-01T00:00:00.000Z");
    const expiredOrder = await transaction.order.create({ data: {
      shopId: otherShop.id, shopifyOrderId: "gid://shopify/Order/8001", name: "#8001",
      shopifyCreatedAt: expiredAt, shopifyUpdatedAt: expiredAt, currencyCode: "AUD",
      subtotalAmount: "100.0000", totalAmount: "100.2500", totalDiscountsAmount: "0.0000",
      totalShippingAmount: "0.0000", totalTaxAmount: "0.0000",
    } });
    const expiredPurchase = await transaction.protectionPurchase.create({ data: {
      shopId: otherShop.id, orderId: expiredOrder.id, currencyCode: "AUD", feeAmount: "0.2500",
      attributionStatus: "UNATTRIBUTED", purchasedAt: expiredAt,
      protectionLineIds: ["gid://shopify/Order/8001/LineItem/2"],
    } });
    const expiredClaim = await transaction.claim.create({ data: {
      shopId: otherShop.id, protectionPurchaseId: expiredPurchase.id, type: "LOST",
    } });
    await transaction.claimEvent.create({ data: { shopId: otherShop.id, claimId: expiredClaim.id, type: "SUBMITTED" } });
    assert.ok(await purgeExpiredOrderBatch(transaction, new Date("2024-06-01T00:00:00.000Z")) >= 1);
    assert.equal(await transaction.order.count({ where: { id: expiredOrder.id } }), 0);
    assert.equal(await transaction.protectionPurchase.count({ where: { id: expiredPurchase.id } }), 0);
    assert.equal(await transaction.claimEvent.count({ where: { claimId: expiredClaim.id } }), 0);
    assert.equal(await transaction.order.count({ where: { id: otherOrder.id } }), 1);
    assert.equal(await transaction.order.count({ where: { id: paidOrder.id } }), 1);
    // Customer redaction removes only the named order in the requesting shop,
    // including its confirmed purchase and append-only claim events.
    assert.equal(await redactCustomerOrders(transaction, shop.shopDomain, [9001]), 1);
    assert.equal(await transaction.order.count({ where: { id: paidOrder.id } }), 0);
    assert.equal(await transaction.protectionPurchase.count({ where: { id: paidPurchase.id } }), 0);
    assert.equal(await transaction.claimEvent.count({ where: { shopId: shop.id, claimId: claim.id } }), 0);
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 1);
    assert.equal(await transaction.order.count({ where: { id: otherOrder.id } }), 1);
    await redactShopData(transaction, shop.shopDomain);
    assert.equal(await transaction.shop.count({ where: { id: shop.id } }), 0);
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await transaction.protectionPurchase.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await transaction.claimEvent.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await transaction.shop.count({ where: { id: otherShop.id } }), 1);
    assert.equal(await transaction.order.count({ where: { shopId: shop.id } }), 0);
    assert.equal(await transaction.order.count({ where: { shopId: otherShop.id } }), 1);
    assert.equal(await transaction.protectionRefund.count({ where: { shopId: shop.id } }), 0);
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
  "PostgreSQL verification passed: durable purchases, reconciliation, refunds, tenant keys, claims, customer redaction, retention purge, and event redaction.",
);
