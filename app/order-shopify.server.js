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
  transactionsCount { count }
  lineItems(first: 250) {
    nodes {
      id quantity requiresShipping
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      discountedTotalSet { shopMoney { amount currencyCode } }
      product { id } variant { id } customAttributes { key value }
    }
    pageInfo { hasNextPage endCursor }
  }
  refunds(first: 250) {
    id processedAt totalRefundedSet { shopMoney { amount currencyCode } }
    refundLineItems(first: 250) {
      nodes { lineItem { id } subtotalSet { shopMoney { amount currencyCode } } }
      pageInfo { hasNextPage endCursor }
    }
    transactions(first: 250) {
      nodes { id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } } }
      pageInfo { hasNextPage endCursor }
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

const LINE_FIELDS = `id quantity requiresShipping
  originalUnitPriceSet { shopMoney { amount currencyCode } }
  discountedTotalSet { shopMoney { amount currencyCode } }
  product { id } variant { id } customAttributes { key value }`;
const REFUND_LINE_FIELDS = `lineItem { id } subtotalSet { shopMoney { amount currencyCode } }`;
const TRANSACTION_FIELDS = `id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } }`;

const LINE_PAGE_QUERY = `#graphql
  query OrderLinePage($id: ID!, $after: String!) {
    order(id: $id) { lineItems(first: 250, after: $after) {
      nodes { ${LINE_FIELDS} } pageInfo { hasNextPage endCursor }
    } }
  }`;
const REFUND_LINE_PAGE_QUERY = `#graphql
  query RefundLinePage($id: ID!, $after: String!) {
    refund(id: $id) { refundLineItems(first: 250, after: $after) {
      nodes { ${REFUND_LINE_FIELDS} } pageInfo { hasNextPage endCursor }
    } }
  }`;
const REFUND_TRANSACTION_PAGE_QUERY = `#graphql
  query RefundTransactionPage($id: ID!, $after: String!) {
    refund(id: $id) { transactions(first: 250, after: $after) {
      nodes { ${TRANSACTION_FIELDS} } pageInfo { hasNextPage endCursor }
    } }
  }`;
const ORDER_VERSION_QUERY = `#graphql query OrderVersion($id: ID!) { order(id: $id) { updatedAt } }`;

async function appendPages(admin, initial, query, id, pick) {
  const nodes = [...initial.nodes];
  let page = initial.pageInfo;
  let count = 1;
  const cursors = new Set();
  while (page.hasNextPage) {
    if (!page.endCursor || cursors.has(page.endCursor) || count >= 100) {
      throw new Error("Shopify connection pagination did not advance.");
    }
    cursors.add(page.endCursor);
    const data = await adminGraphql(admin, query, { id, after: page.endCursor });
    const connection = pick(data);
    if (!connection?.nodes || !connection.pageInfo) throw new Error("Shopify returned an incomplete connection page.");
    nodes.push(...connection.nodes);
    page = connection.pageInfo;
    count += 1;
  }
  return { nodes, pageInfo: { hasNextPage: false, endCursor: page.endCursor } };
}

export function assertCompleteOrder(order) {
  if (!order) throw new Error("Shopify order is unavailable to this app.");
  if (order.lineItems?.pageInfo?.hasNextPage || (order.transactionsCount?.count ?? order.transactions?.length ?? 0) > 250 ||
    (order.refunds?.length ?? 0) >= 250 ||
    order.refunds?.some((refund) => refund.refundLineItems?.pageInfo?.hasNextPage || refund.transactions?.pageInfo?.hasNextPage)) {
    throw new Error("Shopify order data is incomplete.");
  }
  return order;
}

export async function fetchShopifyOrder(admin, id) {
  const data = await adminGraphql(admin, ORDER_QUERY, { id });
  const order = data.order;
  if (!order) throw new Error("Shopify order is unavailable to this app.");
  if ((order.transactionsCount?.count ?? order.transactions?.length ?? 0) > 250) {
    throw new Error("Shopify order has more payment transactions than this API can return safely.");
  }
  if ((order.refunds?.length ?? 0) >= 250) {
    throw new Error("Shopify order has too many refunds for a complete financial snapshot.");
  }
  order.lineItems = await appendPages(admin, order.lineItems, LINE_PAGE_QUERY, id, (result) => result.order?.lineItems);
  for (const refund of order.refunds ?? []) {
    refund.refundLineItems = await appendPages(admin, refund.refundLineItems, REFUND_LINE_PAGE_QUERY, refund.id,
      (result) => result.refund?.refundLineItems);
    refund.transactions = await appendPages(admin, refund.transactions, REFUND_TRANSACTION_PAGE_QUERY, refund.id,
      (result) => result.refund?.transactions);
  }
  const version = await adminGraphql(admin, ORDER_VERSION_QUERY, { id });
  if (version.order?.updatedAt !== order.updatedAt) {
    throw new Error("Shopify order changed during pagination; retry its latest state.");
  }
  return assertCompleteOrder(order);
}
