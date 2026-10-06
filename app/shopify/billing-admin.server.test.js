import { describe, expect, test } from "vitest";
import {
  cancelSubscription,
  createUsageRecord,
  createUsageSubscription,
  readActiveSubscriptions,
  readBillingPreferences,
  readSubscription,
  updateUsageCap,
} from "./billing-admin.server";

const shop = "one.myshopify.com";

function fakeAdmin(responses) {
  const operations = [];
  return {
    operations,
    graphql: async (query, { variables } = {}) => {
      // GraphQL comments run to end of line, as Shopify parses them.
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      const name = query.match(/\b(?:mutation|query)\s+(\w+)/)?.[1];
      operations.push({ name, variables });
      if (!(name in responses)) throw new Error(`Unexpected operation ${name}`);
      return { json: async () => ({ data: responses[name] }) };
    },
  };
}

const usageLineItem = {
  id: "gid://shopify/AppSubscriptionLineItem/1?v=1&index=0",
  plan: { pricingDetails: {
    __typename: "AppUsagePricing", terms: "10% of protection revenue",
    cappedAmount: { amount: "100.0", currencyCode: "AUD" },
    balanceUsed: { amount: "12.5", currencyCode: "AUD" },
  } },
};

describe("billing preferences", () => {
  test("reads the shop and billing currencies and whether it is a development store", async () => {
    const admin = fakeAdmin({ BillingPreferences: {
      shop: { currencyCode: "AUD", plan: { partnerDevelopment: true } },
      shopBillingPreferences: { currency: "AUD" },
    } });
    await expect(readBillingPreferences(admin, shop)).resolves.toEqual({
      shopCurrency: "AUD", billingCurrency: "AUD", developmentStore: true,
    });
  });
});

describe("creating the usage subscription", () => {
  test("requests one capped usage line item and returns the confirmation URL", async () => {
    const admin = fakeAdmin({ CreateRevenueShareSubscription: { appSubscriptionCreate: {
      confirmationUrl: "https://one.myshopify.com/admin/charges/confirm",
      appSubscription: { id: "gid://shopify/AppSubscription/1", lineItems: [usageLineItem] },
      userErrors: [],
    } } });
    const result = await createUsageSubscription(admin, shop, {
      name: "Shipping protection revenue share", terms: "10% of protection revenue",
      cappedAmount: "100.0000", currencyCode: "AUD", returnUrl: "https://admin.shopify.com/x", test: true,
    });
    expect(result).toEqual({
      subscriptionGid: "gid://shopify/AppSubscription/1",
      usageLineItemGid: usageLineItem.id,
      confirmationUrl: "https://one.myshopify.com/admin/charges/confirm",
    });
    expect(admin.operations[0].variables).toEqual({
      name: "Shipping protection revenue share", returnUrl: "https://admin.shopify.com/x", test: true,
      lineItems: [{ plan: { appUsagePricingDetails: {
        terms: "10% of protection revenue", cappedAmount: { amount: "100.0000", currencyCode: "AUD" },
      } } }],
    });
  });

  test("raises Shopify's user errors", async () => {
    const admin = fakeAdmin({ CreateRevenueShareSubscription: { appSubscriptionCreate: {
      confirmationUrl: null, appSubscription: null, userErrors: [{ field: ["returnUrl"], message: "is invalid" }],
    } } });
    await expect(createUsageSubscription(admin, shop, {
      name: "n", terms: "t", cappedAmount: "1", currencyCode: "AUD", returnUrl: "x", test: false,
    })).rejects.toThrow("returnUrl: is invalid");
  });
});

describe("other subscription changes", () => {
  test("asks the merchant to approve a higher cap", async () => {
    const admin = fakeAdmin({ UpdateRevenueShareCap: { appSubscriptionLineItemUpdate: {
      confirmationUrl: "https://confirm", userErrors: [],
    } } });
    await expect(updateUsageCap(admin, shop, { lineItemId: "li", cappedAmount: "200.0000", currencyCode: "AUD" }))
      .resolves.toBe("https://confirm");
    expect(admin.operations[0].variables).toEqual({ id: "li", cappedAmount: { amount: "200.0000", currencyCode: "AUD" } });
  });

  test("cancels a subscription", async () => {
    const admin = fakeAdmin({ CancelRevenueShareSubscription: { appSubscriptionCancel: {
      appSubscription: { id: "sub", status: "CANCELLED" }, userErrors: [],
    } } });
    await expect(cancelSubscription(admin, shop, "sub")).resolves.toBe("CANCELLED");
  });
});

describe("usage records", () => {
  const input = { lineItemId: "li", amount: "1.2300", currencyCode: "AUD", description: "d", idempotencyKey: "charge-1" };

  test("sends the charge ID as the idempotency key", async () => {
    const admin = fakeAdmin({ CreateRevenueShareUsageRecord: { appUsageRecordCreate: {
      appUsageRecord: { id: "gid://shopify/AppUsageRecord/9" }, userErrors: [],
    } } });
    await expect(createUsageRecord(admin, shop, input)).resolves.toEqual({ usageRecordGid: "gid://shopify/AppUsageRecord/9" });
    expect(admin.operations[0].variables).toEqual({
      subscriptionLineItemId: "li", price: { amount: "1.2300", currencyCode: "AUD" },
      description: "d", idempotencyKey: "charge-1",
    });
  });

  test("returns Shopify's refusal for the caller to classify", async () => {
    const admin = fakeAdmin({ CreateRevenueShareUsageRecord: { appUsageRecordCreate: {
      appUsageRecord: null, userErrors: [{ field: null, message: "Failed to create usage charge" }],
    } } });
    await expect(createUsageRecord(admin, shop, input)).resolves.toEqual({ errors: ["Failed to create usage charge"] });
  });
});

describe("reading subscriptions", () => {
  const subscription = {
    id: "gid://shopify/AppSubscription/1", name: "Shipping protection revenue share (terms v2)",
    status: "ACTIVE", test: false, currentPeriodEnd: "2026-11-01T00:00:00Z", lineItems: [usageLineItem],
  };
  const normalized = {
    id: subscription.id, name: subscription.name, status: "ACTIVE", test: false,
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    usageLineItem: { id: usageLineItem.id, cappedAmount: "100.0", balanceUsed: "12.5", currencyCode: "AUD" },
  };

  test("lists the active subscriptions with their usage line item", async () => {
    const admin = fakeAdmin({ RevenueShareSubscriptions: { currentAppInstallation: { activeSubscriptions: [subscription] } } });
    await expect(readActiveSubscriptions(admin, shop)).resolves.toEqual([normalized]);
  });

  test("reads one subscription by ID", async () => {
    const admin = fakeAdmin({ RevenueShareSubscription: { node: subscription } });
    await expect(readSubscription(admin, shop, subscription.id)).resolves.toEqual(normalized);
    const missing = fakeAdmin({ RevenueShareSubscription: { node: null } });
    await expect(readSubscription(missing, shop, "gone")).resolves.toBeNull();
  });
});
