import { describe, expect, test, vi } from "vitest";
import { persistNormalizedOrder } from "./order-ingestion.server";

const shop = { id: "shop-1", shopDomain: "one.myshopify.com" };
const rule = {
  id: "pricing-1",
  shopId: shop.id,
  ruleId: "rule-1",
  version: 1,
  productId: "gid://shopify/Product/9",
  variantId: "gid://shopify/ProductVariant/10",
  rateBasisPoints: 25,
  basis: "SHIPPABLE_PRE_DISCOUNT",
};

function normalizedOrder(protectionAttributes = null) {
  const lines = [
    {
      shopifyLineItemId: "gid://shopify/LineItem/1",
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
  if (protectionAttributes !== null) {
    lines.push({
      shopifyLineItemId: "gid://shopify/LineItem/2",
      productId: rule.productId,
      variantId: rule.variantId,
      quantity: 1,
      requiresShipping: false,
      currencyCode: "AUD",
      originalUnitAmount: "0.2500",
      preDiscountAmount: "0.2500",
      totalDiscountAmount: "0.0000",
      finalAmount: "0.2500",
      protectionAttributes,
    });
  }
  return {
    shopifyOrderId: "gid://shopify/Order/1",
    name: "#1",
    checkoutTokenHash: "hashed",
    shopifyCreatedAt: new Date("2026-09-23T00:00:00Z"),
    shopifyUpdatedAt: new Date("2026-09-23T00:01:00Z"),
    processedAt: new Date("2026-09-23T00:00:30Z"),
    currencyCode: "AUD",
    subtotalAmount: "100.2500",
    totalAmount: "100.2500",
    totalDiscountsAmount: "0.0000",
    totalShippingAmount: "0.0000",
    totalTaxAmount: "0.0000",
    lines,
  };
}

function transaction(rules = [rule]) {
  let storedPurchase = null;
  const purchaseUpsert = vi.fn(async ({ create, update }) => {
    storedPurchase = storedPurchase ? { ...storedPurchase, ...update } : { id: "purchase-1", ...create };
    return storedPurchase;
  });
  const purchaseDeleteMany = vi.fn(async ({ where }) => {
    if (storedPurchase && storedPurchase.purchasedAt === where.purchasedAt) storedPurchase = null;
  });
  const createMany = vi.fn();
  let storedOrder = null;
  return {
    pricingRule: { findMany: vi.fn().mockResolvedValue(rules) },
    order: {
      findUnique: vi.fn(async () => storedOrder),
      upsert: vi.fn(async ({ create, update }) => {
        storedOrder = storedOrder ? { ...storedOrder, ...update } : { id: "order-1", ...create };
        return storedOrder;
      }),
      updateMany: vi.fn(async ({ data }) => {
        if (!storedOrder.firstPaidAt) storedOrder = { ...storedOrder, ...data };
      }),
      update: vi.fn(async ({ data }) => {
        storedOrder = { ...storedOrder, ...data };
        return storedOrder;
      }),
    },
    orderLine: {
      deleteMany: vi.fn(),
      createMany,
    },
    protectionPurchase: {
      upsert: purchaseUpsert,
      deleteMany: purchaseDeleteMany,
      findUnique: vi.fn(async () => storedPurchase),
    },
    purchaseUpsert,
    purchaseDeleteMany,
    createMany,
    storedOrder: () => storedOrder,
    storedPurchase: () => storedPurchase,
  };
}

describe("normalized order persistence", () => {
  test("stores every unprotected order without a protection purchase", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder());
    expect(tx.createMany).toHaveBeenCalledOnce();
    expect(tx.purchaseDeleteMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", shopId: "shop-1", purchasedAt: null },
    });
    expect(tx.purchaseUpsert).not.toHaveBeenCalled();
  });

  test("attributes a protected order to an exact rule snapshot", async () => {
    const tx = transaction();
    await persistNormalizedOrder(
      tx,
      shop,
      normalizedOrder({
        _yasas_protection_rule_id: "rule-1",
        _yasas_protection_rule_version: "1",
        _yasas_protection_rate_bps: "25",
        _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
        _yasas_protection_contract_version: "2",
      }),
    );
    expect(tx.purchaseUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          shopId: "shop-1",
          pricingRuleId: "pricing-1",
          eligibleSubtotalAmount: "100.0000",
          feeAmount: "0.2500",
          pricingContractVersion: 2,
          attributionStatus: "ATTRIBUTED",
        }),
      }),
    );
    expect(tx.purchaseUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId_shopId: { orderId: "order-1", shopId: "shop-1" } },
    }));
    expect(tx.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.arrayContaining([expect.objectContaining({ shopId: "shop-1" })]),
    }));
  });

  test("keeps protection with missing provenance as unattributed", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder({}));
    expect(tx.purchaseUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          pricingRuleId: null,
          attributionStatus: "UNATTRIBUTED",
        }),
      }),
    );
  });

  test("does not attribute an unknown pricing contract version", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder({
      _yasas_protection_rule_id: "rule-1",
      _yasas_protection_rule_version: "1",
      _yasas_protection_rate_bps: "25",
      _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      _yasas_protection_contract_version: "999",
    }));
    expect(tx.storedPurchase().attributionStatus).toBe("UNATTRIBUTED");
  });

  test("scopes rule detection to the current shop", async () => {
    const tx = transaction([{ ...rule, shopId: "shop-2" }]);
    tx.pricingRule.findMany.mockResolvedValue([]);
    await persistNormalizedOrder(tx, shop, normalizedOrder({}));
    expect(tx.purchaseUpsert).not.toHaveBeenCalled();
    expect(tx.pricingRule.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
    });
  });

  test("freezes paid protection history when a later edit removes the line", async () => {
    const tx = transaction();
    const paid = normalizedOrder({});
    paid.paidAt = new Date("2026-09-23T00:02:00Z");
    await persistNormalizedOrder(tx, shop, paid);
    const frozenPurchase = { ...tx.storedPurchase() };
    expect(tx.storedOrder()).toMatchObject({
      paidEligible: true, paidProtected: true, paidProtectionFee: "0.2500",
      paidProtectionLineIds: ["gid://shopify/LineItem/2"],
    });
    const edited = normalizedOrder();
    edited.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
    edited.paidAt = paid.paidAt;
    await persistNormalizedOrder(tx, shop, edited);
    expect(tx.storedOrder().paidProtectionFee).toBe("0.2500");
    expect(tx.storedOrder().paidProtected).toBe(true);
    expect(tx.storedPurchase()).toEqual(frozenPurchase);
    expect(tx.purchaseDeleteMany).not.toHaveBeenCalled();
  });

  test("replaces provisional purchase details until payment, then freezes the paid fee", async () => {
    const tx = transaction();
    const provisional = normalizedOrder({});
    await persistNormalizedOrder(tx, shop, provisional);
    expect(tx.storedPurchase().purchasedAt).toBeNull();
    const paid = normalizedOrder({});
    paid.paidAt = new Date("2026-09-23T00:02:00Z");
    paid.shopifyUpdatedAt = new Date("2026-09-23T00:03:00Z");
    paid.lines[1].finalAmount = "0.3000";
    await persistNormalizedOrder(tx, shop, paid);
    expect(tx.storedPurchase()).toMatchObject({ feeAmount: "0.3000", purchasedAt: paid.paidAt });
    const edited = normalizedOrder({});
    edited.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
    edited.lines[1].finalAmount = "0.5000";
    await persistNormalizedOrder(tx, shop, edited);
    expect(tx.storedPurchase().feeAmount).toBe("0.3000");
    expect(tx.storedOrder().paidProtectionFee).toBe("0.3000");
  });

  test("removes an unpaid provisional purchase when the line disappears", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder({}));
    const edited = normalizedOrder();
    edited.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
    await persistNormalizedOrder(tx, shop, edited);
    expect(tx.storedPurchase()).toBeNull();
  });

  test("ignores an older order snapshot delivered after a newer one", async () => {
    const tx = transaction();
    const newer = normalizedOrder();
    newer.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
    await persistNormalizedOrder(tx, shop, newer);
    await persistNormalizedOrder(tx, shop, normalizedOrder({}));
    expect(tx.order.upsert).toHaveBeenCalledTimes(1);
    expect(tx.storedOrder().shopifyUpdatedAt).toEqual(newer.shopifyUpdatedAt);
  });
});
