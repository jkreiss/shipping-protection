import { describe, expect, test } from "vitest";
import {
  completedPaymentAt,
  normalizeGraphqlOrder,
} from "./order-normalization";

describe("order normalization", () => {
  test("keeps normalized facts while excluding PII and arbitrary properties", () => {
    const normalized = normalizeGraphqlOrder(
      {
        id: "gid://shopify/Order/1001",
        name: "#1001",
        checkoutToken: "sensitive-checkout-token",
        email: "never-store@example.com",
        customer: { id: "gid://shopify/Customer/9", firstName: "Never", lastName: "Store" },
        shippingAddress: { address1: "PII street" },
        createdAt: "2026-09-23T01:00:00Z",
        updatedAt: "2026-09-23T01:01:00Z",
        processedAt: "2026-09-23T01:00:30Z",
        currencyCode: "AUD",
        subtotalPriceSet: { shopMoney: { amount: "100.00" } },
        totalPriceSet: { shopMoney: { amount: "110.25" } },
        totalDiscountsSet: { shopMoney: { amount: "0.00" } },
        totalShippingPriceSet: { shopMoney: { amount: "0.00" } },
        totalTaxSet: { shopMoney: { amount: "10.00" } },
        lineItems: {
          nodes: [
            {
              id: "gid://shopify/LineItem/11",
              quantity: 2,
              requiresShipping: true,
              originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "AUD" } },
              discountedTotalSet: { shopMoney: { amount: "100.00", currencyCode: "AUD" } },
              product: { id: "gid://shopify/Product/21" },
              variant: { id: "gid://shopify/ProductVariant/31" },
              customAttributes: [
                { key: "gift_message", value: "do not persist" },
                { key: "_yasas_protection_rule_id", value: "rule-1" },
              ],
              sellingPlan: { sellingPlanId: "gid://shopify/SellingPlan/1" },
            },
          ],
        },
      },
    );
    expect(normalized).toMatchObject({
      shopifyOrderId: "gid://shopify/Order/1001",
      currencyCode: "AUD",
      subtotalAmount: "100.0000",
    });
    expect(normalized).not.toHaveProperty("checkoutTokenHash");
    expect(normalized.lines[0]).toMatchObject({
      originalUnitAmount: "50.0000",
      preDiscountAmount: "100.0000",
      finalAmount: "100.0000",
      protectionAttributes: { _yasas_protection_rule_id: "rule-1" },
      hasSellingPlan: true,
    });
    const serialized = JSON.stringify(normalized);
    for (const secret of ["sensitive-checkout-token", "never-store@example.com", "Never", "PII street", "gift_message"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("keeps the presentment unit price the customer was charged in", () => {
    const line = (presentmentMoney) => ({
      id: "gid://shopify/LineItem/11", quantity: 1, requiresShipping: true,
      originalUnitPriceSet: { shopMoney: { amount: "50.00", currencyCode: "AUD" }, presentmentMoney },
      discountedTotalSet: { shopMoney: { amount: "50.00", currencyCode: "AUD" } },
      product: null, variant: null, customAttributes: [],
    });
    const order = (presentmentMoney) => ({
      id: "gid://shopify/Order/1001", name: "#1001", createdAt: "2026-09-23T01:00:00Z",
      updatedAt: "2026-09-23T01:01:00Z", currencyCode: "AUD", presentmentCurrencyCode: "USD",
      lineItems: { nodes: [line(presentmentMoney)] },
    });

    const normalized = normalizeGraphqlOrder(order({ amount: "32.50", currencyCode: "USD" }));
    expect(normalized.presentmentCurrencyCode).toBe("USD");
    expect(normalized.lines[0].presentmentUnitAmount).toBe("32.50");

    // A presentment amount in another currency can't be compared, so it's dropped.
    const mismatched = normalizeGraphqlOrder(order({ amount: "50.00", currencyCode: "AUD" }));
    expect(mismatched.lines[0].presentmentUnitAmount).toBeNull();
  });

  test("separates units removed by an order edit from refunded units", () => {
    const money = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" } });
    const line = (n, quantity, currentQuantity) => ({
      id: `gid://shopify/LineItem/${n}`, quantity, currentQuantity, requiresShipping: true,
      originalUnitPriceSet: money("10.00"), discountedTotalSet: money(String(quantity * 10)),
      product: null, variant: null, customAttributes: [],
    });
    const order = {
      id: "gid://shopify/Order/1001", name: "#1001", createdAt: "2026-09-23T01:00:00Z",
      updatedAt: "2026-09-23T01:01:00Z", currencyCode: "AUD",
      lineItems: { nodes: [line(1, 2, 1), line(2, 2, 1), line(3, 2, 2), line(4, 2, 0)] },
      refunds: [{ id: "gid://shopify/Refund/1", refundLineItems: { nodes: [
        { lineItem: { id: "gid://shopify/LineItem/2" }, quantity: 1 },
        { lineItem: { id: "gid://shopify/LineItem/4" }, quantity: 1 },
      ] } }],
    };

    const lines = normalizeGraphqlOrder(order).lines;

    // 1: one unit deleted. 2: one unit refunded, none deleted. 3: untouched.
    // 4: one unit refunded and the other deleted.
    expect(lines.map(({ removedQuantity }) => removedQuantity)).toEqual([1, 0, 0, 1]);
    expect(lines.map(({ quantity }) => quantity)).toEqual([2, 2, 2, 2]);
  });

  test("takes order-level discounts off a line's paid amount, keeping the list price", () => {
    const money = (amount, currencyCode = "USD") => ({ shopMoney: { amount, currencyCode } });
    const line = (n, unit, discountedTotal, allocations) => ({
      id: `gid://shopify/LineItem/${n}`, quantity: 1, requiresShipping: true,
      originalUnitPriceSet: money(unit), discountedTotalSet: money(discountedTotal),
      ...(allocations ? { discountAllocations: allocations.map((amount) => ({ allocatedAmountSet: money(amount) })) } : {}),
      product: null, variant: null, customAttributes: [],
    });
    const order = (lines) => ({
      id: "gid://shopify/Order/1001", name: "#1001", createdAt: "2026-09-23T01:00:00Z",
      updatedAt: "2026-09-23T01:01:00Z", currencyCode: "USD", lineItems: { nodes: lines },
    });

    const [orderDiscounted, lineAndOrderDiscounted, noAllocations, overAllocated] = normalizeGraphqlOrder(order([
      // discountedTotalSet leaves out the 2.00 order-level share.
      line(1, "10.00", "10.00", ["2.00"]),
      // A 1.00 line discount, which discountedTotalSet and the allocations both carry, plus 2.00 at order level.
      line(2, "10.00", "9.00", ["1.00", "2.00"]),
      // Payloads without allocations keep the line-level amount.
      line(3, "10.00", "9.00"),
      line(4, "10.00", "10.00", ["11.00"]),
    ])).lines;

    expect(orderDiscounted).toMatchObject({
      originalUnitAmount: "10.0000", preDiscountAmount: "10.0000", finalAmount: "8.0000", totalDiscountAmount: "2.0000",
    });
    expect(lineAndOrderDiscounted).toMatchObject({ preDiscountAmount: "10.0000", finalAmount: "7.0000", totalDiscountAmount: "3.0000" });
    expect(noAllocations).toMatchObject({ finalAmount: "9.0000", totalDiscountAmount: "1.0000" });
    // An allocation can't take a line below zero.
    expect(overAllocated).toMatchObject({ finalAmount: "0.0000", totalDiscountAmount: "10.0000" });
  });

  test("falls back to the line-level discount when an allocation can't be read", () => {
    const money = (amount, currencyCode) => ({ shopMoney: { amount, currencyCode } });
    const [line] = normalizeGraphqlOrder({
      id: "gid://shopify/Order/1001", name: "#1001", createdAt: "2026-09-23T01:00:00Z",
      updatedAt: "2026-09-23T01:01:00Z", currencyCode: "USD",
      lineItems: { nodes: [{
        id: "gid://shopify/LineItem/1", quantity: 1, requiresShipping: true,
        originalUnitPriceSet: money("10.00", "USD"), discountedTotalSet: money("9.00", "USD"),
        discountAllocations: [{ allocatedAmountSet: money("1.00", "USD") }, { allocatedAmountSet: money("1.00", "EUR") }],
        product: null, variant: null, customAttributes: [],
      }] },
    }).lines;
    expect(line).toMatchObject({ finalAmount: "9.0000", totalDiscountAmount: "1.0000" });
  });

  test("dates a fully paid order at the successful payment threshold", () => {
    const order = {
      currencyCode: "AUD", totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "AUD" } },
      transactions: [
        { kind: "SALE", status: "PENDING", processedAt: "2026-09-23T01:00:00Z", amountSet: { shopMoney: { amount: "100.00", currencyCode: "AUD" } } },
        { kind: "CAPTURE", status: "SUCCESS", processedAt: "2026-09-23T02:00:00Z", amountSet: { shopMoney: { amount: "40.00", currencyCode: "AUD" } } },
        { kind: "CAPTURE", status: "SUCCESS", processedAt: "2026-09-23T03:00:00Z", amountSet: { shopMoney: { amount: "60.00", currencyCode: "AUD" } } },
      ],
    };
    expect(completedPaymentAt(order)).toEqual(new Date("2026-09-23T03:00:00Z"));
    order.transactions[2].status = "FAILURE";
    expect(completedPaymentAt(order)).toBeNull();
  });
});
