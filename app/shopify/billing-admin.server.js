import { adminGraphql, assertUserErrors } from "./admin-graphql.server.js";

// Billing API (manual pricing) operations for the revenue share. They need no
// access scopes: an app may always bill the shop that installed it.

const BILLING_PREFERENCES_QUERY = `#graphql
  query BillingPreferences {
    shop { currencyCode plan { partnerDevelopment } }
    shopBillingPreferences { currency }
  }`;

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation CreateRevenueShareSubscription(
    $name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
      confirmationUrl
      appSubscription { id lineItems { id plan { pricingDetails { __typename } } } }
      userErrors { field message }
    }
  }`;

const UPDATE_CAP_MUTATION = `#graphql
  mutation UpdateRevenueShareCap($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      userErrors { field message }
    }
  }`;

const CANCEL_SUBSCRIPTION_MUTATION = `#graphql
  mutation CancelRevenueShareSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

const CREATE_USAGE_RECORD_MUTATION = `#graphql
  mutation CreateRevenueShareUsageRecord(
    $subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!, $idempotencyKey: String
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId, price: $price,
      description: $description, idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }`;

const SUBSCRIPTION_FIELDS = `
  id name status currentPeriodEnd
  lineItems {
    id
    plan { pricingDetails { ... on AppUsagePricing {
      cappedAmount { amount currencyCode } balanceUsed { amount currencyCode }
    } } }
  }`;

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query RevenueShareSubscriptions {
    currentAppInstallation { activeSubscriptions { test ${SUBSCRIPTION_FIELDS} } }
  }`;

const SUBSCRIPTION_QUERY = `#graphql
  query RevenueShareSubscription($id: ID!) {
    node(id: $id) { ... on AppSubscription { test ${SUBSCRIPTION_FIELDS} } }
  }`;

/**
 * @param {any} subscription
 * @returns {{ id: string, name: string, status: string, test: boolean, currentPeriodEnd: Date | null,
 *   usageLineItem: { id: string, cappedAmount: string, balanceUsed: string, currencyCode: string } | null }}
 */
function normalizeSubscription(subscription) {
  const usage = (subscription.lineItems ?? []).find((item) => item.plan?.pricingDetails?.cappedAmount);
  const pricing = usage?.plan.pricingDetails;
  return {
    id: subscription.id, name: subscription.name, status: subscription.status, test: subscription.test === true,
    currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
    usageLineItem: usage ? {
      id: usage.id, cappedAmount: String(pricing.cappedAmount.amount),
      balanceUsed: String(pricing.balanceUsed.amount), currencyCode: pricing.cappedAmount.currencyCode,
    } : null,
  };
}

export async function readBillingPreferences(admin, shop) {
  const data = await adminGraphql(admin, BILLING_PREFERENCES_QUERY, {}, { shop });
  return {
    shopCurrency: data.shop.currencyCode,
    billingCurrency: data.shopBillingPreferences.currency,
    developmentStore: data.shop.plan?.partnerDevelopment === true,
  };
}

export async function createUsageSubscription(admin, shop, { name, terms, cappedAmount, currencyCode, returnUrl, test }) {
  const data = await adminGraphql(admin, CREATE_SUBSCRIPTION_MUTATION, {
    name, returnUrl, test,
    lineItems: [{ plan: { appUsagePricingDetails: { terms, cappedAmount: { amount: cappedAmount, currencyCode } } } }],
  }, { shop });
  const payload = data.appSubscriptionCreate;
  assertUserErrors(payload, "appSubscriptionCreate");
  const usageLineItem = payload.appSubscription?.lineItems?.find(
    (item) => item.plan?.pricingDetails?.__typename === "AppUsagePricing");
  if (!payload.confirmationUrl || !usageLineItem) throw new Error("Shopify returned no usage subscription.");
  return {
    subscriptionGid: payload.appSubscription.id,
    usageLineItemGid: usageLineItem.id,
    confirmationUrl: payload.confirmationUrl,
  };
}

export async function updateUsageCap(admin, shop, { lineItemId, cappedAmount, currencyCode }) {
  const data = await adminGraphql(admin, UPDATE_CAP_MUTATION, {
    id: lineItemId, cappedAmount: { amount: cappedAmount, currencyCode },
  }, { shop });
  assertUserErrors(data.appSubscriptionLineItemUpdate, "appSubscriptionLineItemUpdate");
  const confirmationUrl = data.appSubscriptionLineItemUpdate.confirmationUrl;
  if (!confirmationUrl) throw new Error("Shopify returned no cap confirmation URL.");
  return confirmationUrl;
}

export async function cancelSubscription(admin, shop, id) {
  const data = await adminGraphql(admin, CANCEL_SUBSCRIPTION_MUTATION, { id }, { shop });
  assertUserErrors(data.appSubscriptionCancel, "appSubscriptionCancel");
  return data.appSubscriptionCancel.appSubscription?.status ?? null;
}

// Shopify's refusals carry no error codes, so they are returned as messages
// for the caller to classify against the subscription's state.
export async function createUsageRecord(admin, shop, { lineItemId, amount, currencyCode, description, idempotencyKey }) {
  const data = await adminGraphql(admin, CREATE_USAGE_RECORD_MUTATION, {
    subscriptionLineItemId: lineItemId, price: { amount, currencyCode }, description, idempotencyKey,
  }, { shop });
  const payload = data.appUsageRecordCreate;
  if (payload.userErrors?.length) return { errors: payload.userErrors.map(({ message }) => message) };
  if (!payload.appUsageRecord?.id) throw new Error("Shopify returned no usage record.");
  return { usageRecordGid: payload.appUsageRecord.id };
}

export async function readActiveSubscriptions(admin, shop) {
  const data = await adminGraphql(admin, ACTIVE_SUBSCRIPTIONS_QUERY, {}, { shop });
  return (data.currentAppInstallation?.activeSubscriptions ?? []).map(normalizeSubscription);
}

export async function readSubscription(admin, shop, id) {
  const data = await adminGraphql(admin, SUBSCRIPTION_QUERY, { id }, { shop });
  return data.node?.id ? normalizeSubscription(data.node) : null;
}
