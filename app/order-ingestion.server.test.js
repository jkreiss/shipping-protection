import { describe, expect, test, vi } from "vitest";
import process from "node:process";
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
    webhookDelivery: { upsert: vi.fn() },
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

  test("never treats merchandise as protection because of its line properties", async () => {
    // Customers can set line properties themselves (theme forms, /cart/add.js).
    const tx = transaction();
    const order = normalizedOrder();
    order.lines[0].protectionAttributes = {
      _yasas_protection_rule_id: "rule-1",
      _yasas_protection_rule_version: "1",
      _yasas_protection_rate_bps: "25",
      _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      _yasas_protection_contract_version: "2",
    };
    order.paidAt = new Date("2026-09-23T00:02:00Z");
    await persistNormalizedOrder(tx, shop, order);
    expect(tx.purchaseUpsert).not.toHaveBeenCalled();
    expect(tx.createMany.mock.calls[0][0].data[0]).toMatchObject({ isProtection: false });
    expect(tx.storedOrder()).toMatchObject({
      paidEligible: true, paidProtected: false, paidProtectionFee: "0.0000",
      paidMerchandiseAmount: "100.0000",
    });
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

  test("drops provenance numbers that would not fit their INTEGER columns", async () => {
    // A customer can set these line properties to anything, including values
    // Postgres would reject, which would fail the order's write on every retry.
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder({
      _yasas_protection_rule_id: "rule-1",
      _yasas_protection_rule_version: "99999999999",
      _yasas_protection_rate_bps: "20000",
      _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      _yasas_protection_contract_version: "99999999999",
    }));
    expect(tx.storedPurchase()).toMatchObject({
      ruleId: "rule-1", ruleVersion: null, rateBasisPoints: null, pricingContractVersion: null,
      attributionStatus: "UNATTRIBUTED",
    });

    const negative = transaction();
    await persistNormalizedOrder(negative, shop, normalizedOrder({
      _yasas_protection_rule_id: "rule-1",
      _yasas_protection_rule_version: "-1",
      _yasas_protection_rate_bps: "0",
      _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      _yasas_protection_contract_version: "2",
    }));
    expect(negative.storedPurchase()).toMatchObject({
      ruleVersion: null, rateBasisPoints: null, pricingContractVersion: 2, attributionStatus: "UNATTRIBUTED",
    });
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

  test("refetches once when a copy from the same second differs", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder());
    await persistNormalizedOrder(tx, shop, normalizedOrder());
    expect(tx.webhookDelivery.upsert).not.toHaveBeenCalled();

    const changed = normalizedOrder();
    changed.financialStatus = "REFUNDED";
    await persistNormalizedOrder(tx, shop, changed);

    expect(tx.webhookDelivery.upsert).toHaveBeenCalledOnce();
    expect(tx.webhookDelivery.upsert.mock.calls[0][0].where.shopId_webhookId).toEqual({
      shopId: "shop-1", webhookId: "same-second:gid://shopify/Order/1:2026-09-23T00:01:00.000Z",
    });
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

const attributed = {
  _yasas_protection_rule_id: "rule-1",
  _yasas_protection_rule_version: "1",
  _yasas_protection_rate_bps: "25",
  _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
  _yasas_protection_contract_version: "2",
};

function chargedProtection(order, shopAmount) {
  Object.assign(order.lines[1], {
    originalUnitAmount: shopAmount, preDiscountAmount: shopAmount, finalAmount: shopAmount,
  });
  return order;
}

function stderrEvents() {
  const writes = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
  return {
    restore: () => spy.mockRestore(),
    named: (event) => writes.map((line) => JSON.parse(line)).filter((entry) => entry.event === event),
  };
}

describe("live price check", () => {
  test("marks a purchase charged at the attributed rate as matched", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder(attributed));
    expect(tx.storedPurchase().pricingCheck).toBe("MATCHED");
  });

  test("marks a purchase charged the fallback price as unmatched", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, chargedProtection(normalizedOrder(attributed), "5.0000"));
    expect(tx.storedPurchase().pricingCheck).toBe("UNMATCHED");
  });

  test("matches the total charged across protection lines", async () => {
    const tx = transaction();
    const order = normalizedOrder(attributed);
    order.lines.push({
      ...order.lines[1], shopifyLineItemId: "gid://shopify/LineItem/3",
      originalUnitAmount: "0.0000", preDiscountAmount: "0.0000", finalAmount: "0.0000",
    });
    await persistNormalizedOrder(tx, shop, order);
    expect(tx.storedPurchase().pricingCheck).toBe("MATCHED");
  });

  test("marks a fee charged per unit as unmatched", async () => {
    const tx = transaction();
    const order = normalizedOrder(attributed);
    Object.assign(order.lines[1], { quantity: 2, preDiscountAmount: "0.5000", finalAmount: "0.5000" });
    await persistNormalizedOrder(tx, shop, order);
    expect(tx.storedPurchase().pricingCheck).toBe("UNMATCHED");
  });

  test("checks the price in the currency the customer paid in", async () => {
    const tx = transaction();
    // Converted to shop money the fee no longer equals 0.25% of the shop subtotal.
    const order = chargedProtection(normalizedOrder(attributed), "0.2400");
    order.presentmentCurrencyCode = "USD";
    order.lines[0].presentmentUnitAmount = "65.00";
    order.lines[1].presentmentUnitAmount = "0.16";

    await persistNormalizedOrder(tx, shop, order);

    expect(tx.storedPurchase().pricingCheck).toBe("MATCHED");
  });

  test("leaves the check empty when no pricing rule is attributed", async () => {
    const tx = transaction();
    await persistNormalizedOrder(tx, shop, normalizedOrder({}));
    expect(tx.storedPurchase().pricingCheck).toBeNull();
  });

  test("alerts once when a paid order was not charged the live price", async () => {
    const events = stderrEvents();
    try {
      const tx = transaction();
      const paid = chargedProtection(normalizedOrder(attributed), "5.0000");
      paid.paidAt = new Date("2026-09-23T00:02:00Z");
      const afterCommit = [];
      await persistNormalizedOrder(tx, shop, paid, afterCommit);
      // The transaction could still roll back, so nothing is sent yet.
      expect(events.named("protection_price_unmatched")).toEqual([]);
      const later = chargedProtection(normalizedOrder(attributed), "5.0000");
      later.paidAt = paid.paidAt;
      later.shopifyUpdatedAt = new Date("2026-09-24T00:00:00Z");
      await persistNormalizedOrder(tx, shop, later, afterCommit);
      for (const report of afterCommit) report();

      expect(events.named("protection_price_unmatched")).toEqual([expect.objectContaining({
        shopId: "shop-1", shopifyOrderId: "gid://shopify/Order/1",
        feeAmount: "5.0000", expectedFeeAmount: "0.25",
      })]);
    } finally {
      events.restore();
    }
  });

  test("does not count a subscription order as protected or alert on its $0.00 fee", async () => {
    const events = stderrEvents();
    try {
      const tx = transaction();
      const paid = chargedProtection(normalizedOrder(attributed), "0.0000");
      paid.lines[0].hasSellingPlan = true;
      paid.paidAt = new Date("2026-09-23T00:02:00Z");
      const afterCommit = [];
      await persistNormalizedOrder(tx, shop, paid, afterCommit);
      for (const report of afterCommit) report();

      expect(tx.purchaseUpsert).not.toHaveBeenCalled();
      expect(tx.storedPurchase()).toBeNull();
      expect(tx.storedOrder()).toMatchObject({ paidProtected: false, paidProtectionFee: "0.0000" });
      expect(events.named("protection_price_unmatched")).toEqual([]);
    } finally {
      events.restore();
    }
  });

  test("does not count a subscription order as protected even when a fee was charged", async () => {
    const tx = transaction();
    const order = normalizedOrder(attributed);
    order.lines[0].hasSellingPlan = true;
    order.paidAt = new Date("2026-09-23T00:02:00Z");
    await persistNormalizedOrder(tx, shop, order);
    expect(tx.purchaseUpsert).not.toHaveBeenCalled();
    expect(tx.storedOrder().paidProtected).toBe(false);
  });

  test("does not alert for a paid order charged the live price", async () => {
    const events = stderrEvents();
    try {
      const tx = transaction();
      const paid = normalizedOrder(attributed);
      paid.paidAt = new Date("2026-09-23T00:02:00Z");
      await persistNormalizedOrder(tx, shop, paid);
      expect(events.named("protection_price_unmatched")).toEqual([]);
    } finally {
      events.restore();
    }
  });
});
