import { createHmac } from "node:crypto";

export const PROTECTION_ATTRIBUTE_NAMES = Object.freeze([
  "_yasas_protection_rule_id",
  "_yasas_protection_rule_version",
  "_yasas_protection_rate_bps",
  "_yasas_protection_basis",
]);

const MONEY_SCALE = 10_000n;

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Order payload is missing ${field}.`);
  }
  return value;
}

function requiredDate(value, field) {
  const date = new Date(requiredString(value, field));
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`Order payload has an invalid ${field}.`);
  }
  return date;
}

export function moneyToScaled(value) {
  const text = String(value ?? "");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error("Order payload contains an invalid monetary amount.");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const firstFour = fraction.slice(0, 4).padEnd(4, "0");
  const discarded = fraction.slice(4);
  if (discarded && /[1-9]/.test(discarded)) {
    throw new Error("Order payload monetary precision exceeds four decimals.");
  }
  const scaled = BigInt(whole) * MONEY_SCALE + BigInt(firstFour);
  return negative ? -scaled : scaled;
}

export function scaledToMoney(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function multiplyMoney(value, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Order payload contains an invalid line quantity.");
  }
  return scaledToMoney(moneyToScaled(value) * BigInt(quantity));
}

function gid(type, value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  return text.startsWith("gid://shopify/")
    ? text
    : `gid://shopify/${type}/${text}`;
}

function allowListedAttributes(attributes) {
  const allowed = new Set(PROTECTION_ATTRIBUTE_NAMES);
  return Object.fromEntries(
    (attributes ?? [])
      .map((attribute) => ({
        key: attribute.key ?? attribute.name,
        value: attribute.value,
      }))
      .filter(
        ({ key, value }) =>
          allowed.has(key) && typeof value === "string" && value.length > 0,
      )
      .map(({ key, value }) => [key, value]),
  );
}

export function hashCheckoutToken(token, secret) {
  if (!token) return null;
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("CHECKOUT_TOKEN_HASH_SECRET must contain at least 16 characters.");
  }
  return createHmac("sha256", secret).update(String(token)).digest("hex");
}

export function normalizeWebhookOrder(payload, hashSecret) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.line_items)) {
    throw new Error("Malformed orders/create payload.");
  }
  const currencyCode = requiredString(payload.currency, "currency");
  const lines = payload.line_items.map((line) => {
    const quantity = Number(line.quantity);
    const preDiscountAmount = multiplyMoney(line.price, quantity);
    const discount = scaledToMoney(moneyToScaled(line.total_discount ?? "0"));
    return {
      shopifyLineItemId: requiredString(
        gid("LineItem", line.admin_graphql_api_id ?? line.id),
        "line item id",
      ),
      productId: gid("Product", line.product_id),
      variantId: gid("ProductVariant", line.variant_id),
      quantity,
      requiresShipping: line.requires_shipping === true,
      currencyCode,
      originalUnitAmount: scaledToMoney(moneyToScaled(line.price)),
      preDiscountAmount,
      totalDiscountAmount: discount,
      finalAmount: scaledToMoney(
        moneyToScaled(preDiscountAmount) - moneyToScaled(discount),
      ),
      protectionAttributes: allowListedAttributes(line.properties),
    };
  });

  return {
    shopifyOrderId: requiredString(
      gid("Order", payload.admin_graphql_api_id ?? payload.id),
      "id",
    ),
    name: requiredString(payload.name, "name"),
    checkoutTokenHash: hashCheckoutToken(payload.checkout_token, hashSecret),
    shopifyCreatedAt: requiredDate(payload.created_at, "created_at"),
    shopifyUpdatedAt: requiredDate(payload.updated_at, "updated_at"),
    processedAt: payload.processed_at
      ? requiredDate(payload.processed_at, "processed_at")
      : null,
    isTest: payload.test === true,
    cancelledAt: payload.cancelled_at ? requiredDate(payload.cancelled_at, "cancelled_at") : null,
    financialStatus: payload.financial_status ?? null,
    currencyCode,
    subtotalAmount: scaledToMoney(moneyToScaled(payload.subtotal_price ?? "0")),
    totalAmount: scaledToMoney(moneyToScaled(payload.total_price ?? "0")),
    totalDiscountsAmount: scaledToMoney(
      moneyToScaled(payload.total_discounts ?? "0"),
    ),
    totalShippingAmount: scaledToMoney(
      moneyToScaled(payload.total_shipping_price_set?.shop_money?.amount ?? "0"),
    ),
    totalTaxAmount: scaledToMoney(moneyToScaled(payload.total_tax ?? "0")),
    lines,
  };
}

function shopMoney(moneySet, fallback = "0") {
  return moneySet?.shopMoney?.amount ?? fallback;
}

export function normalizeGraphqlOrder(order, hashSecret) {
  if (!order || typeof order !== "object" || !Array.isArray(order.lineItems?.nodes)) {
    throw new Error("Malformed Admin GraphQL order.");
  }
  const currencyCode = requiredString(order.currencyCode, "currencyCode");
  const moneySets = [order.subtotalPriceSet, order.totalPriceSet, order.totalDiscountsSet, order.totalShippingPriceSet, order.totalTaxSet];
  for (const set of moneySets) {
    if (set?.shopMoney?.currencyCode && set.shopMoney.currencyCode !== currencyCode) {
      throw new Error("Order shop money currency differs from its currency code.");
    }
  }
  const lines = order.lineItems.nodes.map((line) => {
    const quantity = Number(line.quantity);
    if (!line.originalUnitPriceSet?.shopMoney || !line.discountedTotalSet?.shopMoney ||
      line.originalUnitPriceSet.shopMoney.currencyCode !== currencyCode ||
      line.discountedTotalSet.shopMoney.currencyCode !== currencyCode) {
      throw new Error("Order line shop money is missing or uses a different currency.");
    }
    const unit = shopMoney(line.originalUnitPriceSet);
    const preDiscountAmount = multiplyMoney(unit, quantity);
    const finalAmount = shopMoney(line.discountedTotalSet, preDiscountAmount);
    return {
      shopifyLineItemId: requiredString(line.id, "line item id"),
      productId: line.product?.id ?? null,
      variantId: line.variant?.id ?? null,
      quantity,
      requiresShipping: line.requiresShipping === true,
      currencyCode,
      originalUnitAmount: scaledToMoney(moneyToScaled(unit)),
      preDiscountAmount,
      totalDiscountAmount: scaledToMoney(
        moneyToScaled(preDiscountAmount) - moneyToScaled(finalAmount),
      ),
      finalAmount: scaledToMoney(moneyToScaled(finalAmount)),
      protectionAttributes: allowListedAttributes(line.customAttributes),
    };
  });

  return {
    shopifyOrderId: requiredString(order.id, "id"),
    name: requiredString(order.name, "name"),
    checkoutTokenHash: hashCheckoutToken(order.checkoutToken, hashSecret),
    shopifyCreatedAt: requiredDate(order.createdAt, "createdAt"),
    shopifyUpdatedAt: requiredDate(order.updatedAt, "updatedAt"),
    processedAt: order.processedAt ? requiredDate(order.processedAt, "processedAt") : null,
    isTest: order.test === true,
    cancelledAt: order.cancelledAt ? requiredDate(order.cancelledAt, "cancelledAt") : null,
    financialStatus: order.displayFinancialStatus ?? null,
    paidAt: completedPaymentAt(order),
    refunds: order.refunds ?? [],
    currencyCode,
    subtotalAmount: scaledToMoney(moneyToScaled(shopMoney(order.subtotalPriceSet))),
    totalAmount: scaledToMoney(moneyToScaled(shopMoney(order.totalPriceSet))),
    totalDiscountsAmount: scaledToMoney(
      moneyToScaled(shopMoney(order.totalDiscountsSet)),
    ),
    totalShippingAmount: scaledToMoney(
      moneyToScaled(shopMoney(order.totalShippingPriceSet)),
    ),
    totalTaxAmount: scaledToMoney(moneyToScaled(shopMoney(order.totalTaxSet))),
    lines,
  };
}

export function completedPaymentAt(order) {
  const payments = (order.transactions ?? [])
    .filter((item) => item.status === "SUCCESS" && ["SALE", "CAPTURE"].includes(item.kind))
    .map((item) => ({
      at: item.processedAt ?? item.createdAt,
      amount: item.amountSet?.shopMoney,
    }))
    .filter((item) => item.at && item.amount && item.amount.currencyCode === order.currencyCode)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const total = moneyToScaled(shopMoney(order.totalPriceSet));
  let received = 0n;
  for (const payment of payments) {
    received += moneyToScaled(payment.amount.amount);
    if (total > 0n && received >= total) return requiredDate(payment.at, "payment processedAt");
  }
  if (order.fullyPaid && total === 0n) {
    return order.processedAt ? requiredDate(order.processedAt, "processedAt") : null;
  }
  return null;
}
