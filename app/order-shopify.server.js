import { normalizeGraphqlOrder } from "./order-normalization.js";
import { adminGraphql } from "./shopify/admin-graphql.server.js";

// Selections shared by the order query and the queries that page its connections.
export const LINE_FIELDS = `id quantity currentQuantity requiresShipping
  originalUnitPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
  discountedTotalSet { shopMoney { amount currencyCode } }
  product { id } variant { id } customAttributes { key value }
  sellingPlan { sellingPlanId }`;
export const REFUND_LINE_FIELDS = `lineItem { id } quantity subtotalSet { shopMoney { amount currencyCode } }`;
export const TRANSACTION_FIELDS = `id kind status processedAt createdAt amountSet { shopMoney { amount currencyCode } }`;

// Keep this selection shared by direct webhook refreshes and reconciliation.
export const ORDER_FIELDS = `
  id name createdAt updatedAt processedAt currencyCode presentmentCurrencyCode
  test cancelledAt displayFinancialStatus fullyPaid
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } }
  transactions(first: 250) {
    ${TRANSACTION_FIELDS}
  }
  transactionsCount { count }
  lineItems(first: 250) {
    nodes { ${LINE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
  refunds(first: 250) {
    id processedAt totalRefundedSet { shopMoney { amount currencyCode } }
    refundLineItems(first: 250) {
      nodes { ${REFUND_LINE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    transactions(first: 250) {
      nodes { ${TRANSACTION_FIELDS} }
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
const ORDER_VERSION_QUERY = `#graphql
  query OrderVersion($id: ID!) { order(id: $id) { updatedAt } }`;

async function appendPages(admin, initial, query, id, pick, options) {
  const nodes = [...initial.nodes];
  let page = initial.pageInfo;
  let count = 1;
  const cursors = new Set();
  while (page.hasNextPage) {
    if (!page.endCursor || cursors.has(page.endCursor) || count >= 100) {
      throw new Error("Shopify connection pagination did not advance.");
    }
    cursors.add(page.endCursor);
    const data = await adminGraphql(admin, query, { id, after: page.endCursor }, options);
    const connection = pick(data);
    if (!connection?.nodes || !connection.pageInfo) throw new Error("Shopify returned an incomplete connection page.");
    nodes.push(...connection.nodes);
    page = connection.pageInfo;
    count += 1;
  }
  return { nodes, pageInfo: { hasNextPage: false, endCursor: page.endCursor }, paged: count > 1 };
}

// Shopify's answer won't change on a retry, such as an order outside the
// app's access or too large to snapshot, so the worker stops at once.
export class PermanentOrderError extends Error {
  name = "PermanentOrderError";
}

// Shopify returned no order: deleted, or older than the 60 days the app can
// read without read_all_orders. Protection is non-refundable once shipped, so
// a late refund on such an order needs no record.
export class OrderUnavailableError extends PermanentOrderError {
  name = "OrderUnavailableError";
}

// An order past what one response can return cannot be snapshotted whole, and
// asking again won't change that.
function assertWithinLimits(order) {
  if ((order.transactionsCount?.count ?? order.transactions?.length ?? 0) > 250) {
    throw new PermanentOrderError("Shopify order has more payment transactions than this API can return safely.");
  }
  if ((order.refunds?.length ?? 0) >= 250) {
    throw new PermanentOrderError("Shopify order has too many refunds for a complete financial snapshot.");
  }
}

export function assertCompleteOrder(order) {
  if (!order) throw new Error("Shopify order is unavailable to this app.");
  assertWithinLimits(order);
  if (order.lineItems?.pageInfo?.hasNextPage ||
    order.refunds?.some((refund) => refund.refundLineItems?.pageInfo?.hasNextPage || refund.transactions?.pageInfo?.hasNextPage)) {
    throw new Error("Shopify order data is incomplete.");
  }
  return order;
}

// Data Shopify returned that can't be normalized won't change on a retry.
export function normalizeFetchedOrder(order) {
  try {
    return normalizeGraphqlOrder(order);
  } catch (error) {
    throw new PermanentOrderError("Shopify order could not be normalized.", { cause: error });
  }
}

// Pass `shop` so the calls share that shop's API budget (see adminGraphql).
export async function fetchShopifyOrder(admin, id, options = {}) {
  const data = await adminGraphql(admin, ORDER_QUERY, { id }, options);
  const order = data.order;
  if (!order) throw new OrderUnavailableError("Shopify order is unavailable to this app.");
  assertWithinLimits(order);
  const connections = [];
  const page = async (initial, query, ownerId, pick) => {
    const { paged, ...connection } = await appendPages(admin, initial, query, ownerId, pick, options);
    connections.push(paged);
    return connection;
  };
  order.lineItems = await page(order.lineItems, LINE_PAGE_QUERY, id, (result) => result.order?.lineItems);
  for (const refund of order.refunds ?? []) {
    refund.refundLineItems = await page(refund.refundLineItems, REFUND_LINE_PAGE_QUERY, refund.id,
      (result) => result.refund?.refundLineItems);
    refund.transactions = await page(refund.transactions, REFUND_TRANSACTION_PAGE_QUERY, refund.id,
      (result) => result.refund?.transactions);
  }
  // One response is already a single read. Only paged data can mix versions.
  if (connections.some(Boolean)) {
    const version = await adminGraphql(admin, ORDER_VERSION_QUERY, { id }, options);
    if (version.order?.updatedAt !== order.updatedAt) {
      throw new Error("Shopify order changed during pagination; retry its latest state.");
    }
  }
  return assertCompleteOrder(order);
}
