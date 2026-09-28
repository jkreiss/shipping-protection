import { adminGraphql } from "./shopify/admin-graphql.server.js";

// Keep this selection shared by direct webhook refreshes and reconciliation.
export const ORDER_FIELDS = `
  id name checkoutToken createdAt updatedAt processedAt currencyCode
  test cancelledAt displayFinancialStatus fullyPaid
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } }
  transactions(first: 250) {
    id kind status createdAt processedAt amountSet { shopMoney { amount currencyCode } }
  }
  lineItems(first: 250) {
    nodes {
      id quantity requiresShipping
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      discountedTotalSet { shopMoney { amount currencyCode } }
      product { id } variant { id } customAttributes { key value }
    }
    pageInfo { hasNextPage }
  }
  refunds {
    id processedAt totalRefundedSet { shopMoney { amount currencyCode } }
    refundLineItems(first: 250) {
      nodes { lineItem { id } subtotalSet { shopMoney { amount currencyCode } } }
      pageInfo { hasNextPage }
    }
    transactions(first: 250) {
      nodes { id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } } }
      pageInfo { hasNextPage }
    }
  }
`;

export const ORDER_QUERY = `#graphql
  query AnalyticsOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }
`;

export const ORDERS_QUERY = `#graphql
  query ReconcileOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
      nodes { id updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export { adminGraphql };

export function assertCompleteOrder(order) {
  if (!order) throw new Error("Shopify order is unavailable to this app.");
  if (order.lineItems?.pageInfo?.hasNextPage || (order.transactions?.length ?? 0) >= 250 ||
    order.refunds?.some((refund) => refund.refundLineItems?.pageInfo?.hasNextPage || refund.transactions?.pageInfo?.hasNextPage)) {
    throw new Error("Order exceeds the analytics query page size; its data needs a larger reconciliation path.");
  }
  return order;
}

export async function fetchShopifyOrder(admin, id) {
  const data = await adminGraphql(admin, ORDER_QUERY, { id });
  return assertCompleteOrder(data.order);
}
