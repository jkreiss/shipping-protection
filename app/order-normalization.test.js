import { describe, expect, test } from "vitest";
import {
  completedPaymentAt,
  normalizeGraphqlOrder,
  normalizeWebhookOrder,
} from "./order-normalization";

function webhookPayload(overrides = {}) {
  return {
    id: 1001,
    admin_graphql_api_id: "gid://shopify/Order/1001",
    name: "#1001",
    checkout_token: "sensitive-checkout-token",
    created_at: "2026-09-23T01:00:00Z",
    updated_at: "2026-09-23T01:01:00Z",
    processed_at: "2026-09-23T01:00:30Z",
    currency: "AUD",
    subtotal_price: "100.00",
    total_price: "110.25",
    total_discounts: "0.00",
    total_tax: "10.00",
    total_shipping_price_set: { shop_money: { amount: "0.00" } },
    email: "never-store@example.com",
    customer: { id: 9, first_name: "Never", last_name: "Store" },
    shipping_address: { address1: "PII street" },
    line_items: [
      {
        id: 11,
        product_id: 21,
        variant_id: 31,
        quantity: 2,
        price: "50.00",
        total_discount: "0.00",
        requires_shipping: true,
        properties: [
          { name: "gift_message", value: "do not persist" },
          { name: "_yasas_protection_rule_id", value: "rule-1" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("order normalization", () => {
  test("keeps normalized facts while excluding PII and arbitrary properties", () => {
    const normalized = normalizeWebhookOrder(webhookPayload());
    expect(normalized).toMatchObject({
      shopifyOrderId: "gid://shopify/Order/1001",
      currencyCode: "AUD",
      subtotalAmount: "100.0000",
    });
    expect(normalized).not.toHaveProperty("checkoutTokenHash");
    expect(normalized.lines[0]).toMatchObject({
      quantity: 2,
      preDiscountAmount: "100.0000",
      protectionAttributes: {
        _yasas_protection_rule_id: "rule-1",
      },
    });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("never-store@example.com");
    expect(serialized).not.toContain("Never");
    expect(serialized).not.toContain("PII street");
    expect(serialized).not.toContain("gift_message");
    expect(serialized).not.toContain("sensitive-checkout-token");
  });

  test("rejects malformed payloads", () => {
    expect(() => normalizeWebhookOrder({})).toThrow(
      "Malformed orders/create payload",
    );
  });

  test("normalizes the reconciliation GraphQL shape identically", () => {
    const normalized = normalizeGraphqlOrder(
      {
        id: "gid://shopify/Order/1001",
        name: "#1001",
        checkoutToken: "sensitive-checkout-token",
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
              customAttributes: [{ key: "ignored", value: "value" }],
            },
          ],
        },
      },
    );
    expect(normalized.lines[0]).toMatchObject({
      originalUnitAmount: "50.0000",
      preDiscountAmount: "100.0000",
      finalAmount: "100.0000",
      protectionAttributes: {},
    });
    expect(JSON.stringify(normalized)).not.toContain("sensitive-checkout-token");
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
