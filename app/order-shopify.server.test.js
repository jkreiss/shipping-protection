import { describe, expect, test } from "vitest";
import { adminGraphql } from "./order-shopify.server";

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
