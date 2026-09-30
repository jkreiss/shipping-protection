import { describe, expect, test, vi } from "vitest";
import process from "node:process";
import { adminGraphql, fetchShopifyOrder } from "./order-shopify.server";

describe("Admin GraphQL response handling", () => {
  test("rejects search warnings before a reconciliation scan can advance", async () => {
    const admin = {
      graphql: async () => ({
        json: async () => ({
          data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } },
          extensions: {
            search: [{
              path: ["orders"],
              warnings: [{ code: "invalid_field", message: "Invalid search field for this query." }],
            }],
          },
        }),
      }),
    };

    await expect(adminGraphql(admin, "query Orders { orders(first: 1) { nodes { id } } }"))
      .rejects.toThrow("Shopify search warning: Invalid search field for this query.");
  });
});

describe("large order pagination", () => {
  test("combines order and refund pages before returning a complete snapshot", async () => {
    const order = {
      id: "gid://shopify/Order/1", updatedAt: "2026-09-29T00:00:00Z",
      transactions: [], transactionsCount: { count: 0 },
      lineItems: { nodes: [{ id: "line-1" }], pageInfo: { hasNextPage: true, endCursor: "line-cursor" } },
      refunds: [{ id: "gid://shopify/Refund/2",
        refundLineItems: { nodes: [{ lineItem: { id: "line-1" } }], pageInfo: { hasNextPage: true, endCursor: "refund-cursor" } },
        transactions: { nodes: [{ id: "tx-1" }], pageInfo: { hasNextPage: true, endCursor: "tx-cursor" } },
      }],
    };
    const admin = { graphql: async (query, { variables }) => {
      // GraphQL comments run to end of line, as Shopify parses them.
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      let data;
      if (query.includes("query AnalyticsOrder")) data = { order };
      else if (query.includes("query OrderLinePage")) {
        expect(variables.after).toBe("line-cursor");
        data = { order: { lineItems: { nodes: [{ id: "line-2" }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      } else if (query.includes("query RefundLinePage")) {
        expect(variables.after).toBe("refund-cursor");
        data = { refund: { refundLineItems: { nodes: [{ lineItem: { id: "line-2" } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      } else if (query.includes("query RefundTransactionPage")) {
        expect(variables.after).toBe("tx-cursor");
        data = { refund: { transactions: { nodes: [{ id: "tx-2" }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      } else if (query.includes("query OrderVersion")) {
        versionChecks += 1;
        data = { order: { updatedAt: order.updatedAt } };
      } else throw new Error("unexpected query");
      return { json: async () => ({ data }) };
    } };
    let versionChecks = 0;
    const result = await fetchShopifyOrder(admin, order.id);
    // Paging needs a version check to prove the pages form one snapshot.
    expect(versionChecks).toBe(1);
    expect(result.lineItems.nodes.map(({ id }) => id)).toEqual(["line-1", "line-2"]);
    expect(result.refunds[0].refundLineItems.nodes).toHaveLength(2);
    expect(result.refunds[0].transactions.nodes).toHaveLength(2);
  });
});

describe("per-shop API budget", () => {
  test("tags every order query with the shop so the worker paces it", async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
    const order = {
      id: "gid://shopify/Order/5", updatedAt: "2026-09-29T00:00:00Z",
      transactions: [], transactionsCount: { count: 0 }, refunds: [],
      lineItems: { nodes: [{ id: "line-1" }], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const extensions = { cost: { requestedQueryCost: 10, actualQueryCost: 5,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 995, restoreRate: 50 } } };
    const admin = { graphql: async (query) => {
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      return { json: async () => ({ data: { order }, extensions }) };
    } };

    try {
      await fetchShopifyOrder(admin, order.id, { shop: "budget.myshopify.com" });
    } finally {
      spy.mockRestore();
    }

    const costEvents = writes.map((line) => JSON.parse(line)).filter(({ event }) => event === "shopify_graphql_cost");
    expect(costEvents.length).toBeGreaterThan(0);
    expect(costEvents.every(({ shop }) => shop === "budget.myshopify.com")).toBe(true);
  });
});

describe("single-page orders", () => {
  test("fetch the order in one Admin API call", async () => {
    const order = {
      id: "gid://shopify/Order/6", updatedAt: "2026-09-29T00:00:00Z",
      transactions: [], transactionsCount: { count: 0 },
      lineItems: { nodes: [{ id: "line-1" }], pageInfo: { hasNextPage: false, endCursor: null } },
      refunds: [{ id: "gid://shopify/Refund/7",
        refundLineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        transactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }],
    };
    const operations = [];
    const admin = { graphql: async (query) => {
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      operations.push(query.match(/query\s+(\w+)/)[1]);
      return { json: async () => ({ data: { order } }) };
    } };

    await fetchShopifyOrder(admin, order.id);

    expect(operations).toEqual(["AnalyticsOrder"]);
  });
});
