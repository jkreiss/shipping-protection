// Shared, deterministic fixture contract for the future seeder and sender.
export const PROTECTION_VARIANT_ID = "gid://shopify/ProductVariant/9001";
export const PROTECTION_PRODUCT_ID = "gid://shopify/Product/9001";
export const PROTECTION_RULE_ID = "load-protection";
export const shopDomain = (index) => `load-${index}.myshopify.com`;
export const orderId = (index) => `gid://shopify/Order/${index}`;
const money = (amount) => ({ shopMoney: { amount, currencyCode: "AUD" }, presentmentMoney: { amount, currencyCode: "AUD" } });
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

export function generatedOrder(index, tenant, { startAt, intervalMs }) {
  const at = new Date(Date.parse(startAt) + (index - 1) * intervalMs).toISOString();
  const protectedOrder = index % 2 === 0;
  const refunded = index % 10 === 0;
  const total = protectedOrder ? "102.00" : "100.00";
  const line = (id, amount, requiresShipping, variantId, customAttributes = []) => ({
    id: `gid://shopify/LineItem/${id}`, quantity: 1, requiresShipping,
    originalUnitPriceSet: money(amount), discountedTotalSet: money(amount),
    product: { id: requiresShipping ? "gid://shopify/Product/1" : PROTECTION_PRODUCT_ID },
    variant: { id: variantId }, customAttributes, sellingPlan: null,
  });
  const lines = [line(index * 2, "100.00", true, "gid://shopify/ProductVariant/1")];
  if (protectedOrder) lines.push(line(index * 2 + 1, "2.00", false, PROTECTION_VARIANT_ID,
    Object.entries({ _yasas_protection_rule_id: PROTECTION_RULE_ID, _yasas_protection_rule_version: "1",
      _yasas_protection_rate_bps: "200", _yasas_protection_basis: "SHIPPABLE_PRE_DISCOUNT",
      _yasas_protection_contract_version: "2" }).map(([key, value]) => ({ key, value }))));
  const transaction = (kind, amount, id) => ({ id: `gid://shopify/OrderTransaction/${id}`,
    kind, status: "SUCCESS", createdAt: at, processedAt: at, amountSet: money(amount) });
  return {
    id: orderId(index), name: `#LOAD-${tenant}-${index}`, createdAt: at, updatedAt: at, processedAt: at,
    currencyCode: "AUD", presentmentCurrencyCode: "AUD", test: false, cancelledAt: null,
    displayFinancialStatus: refunded ? "PARTIALLY_REFUNDED" : "PAID", fullyPaid: true,
    subtotalPriceSet: money(total), totalPriceSet: money(total), totalDiscountsSet: money("0.00"),
    totalShippingPriceSet: money("0.00"), totalTaxSet: money("0.00"),
    transactions: [transaction("SALE", total, index * 2)], transactionsCount: { count: 1 },
    lineItems: connection(lines),
    refunds: refunded ? [{ id: `gid://shopify/Refund/${index}`, processedAt: at,
      totalRefundedSet: money("2.00"), refundLineItems: connection([{ lineItem: { id: lines[1].id }, subtotalSet: money("2.00") }]),
      transactions: connection([transaction("REFUND", "2.00", index * 2 + 1)]) }] : [],
  };
}
