import { describe, expect, test, vi } from "vitest";
import { recordGrantedScopes } from "./shop.server";

function database() {
  return { session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
}

describe("granted scopes", () => {
  test("stores the current scopes on the shop's own session", async () => {
    const db = database();
    const recorded = await recordGrantedScopes({
      shopDomain: "one.myshopify.com", sessionId: "offline_one.myshopify.com",
      scopes: ["write_products", "read_orders"], database: db,
    });
    expect(recorded).toBe(true);
    expect(db.session.updateMany).toHaveBeenCalledWith({
      where: { id: "offline_one.myshopify.com", shop: "one.myshopify.com" },
      data: { scope: "write_products,read_orders" },
    });
  });

  test.each([
    ["missing", undefined],
    ["not a list", "write_products"],
    ["not scope names", [{ handle: "write_products" }]],
  ])("ignores a payload whose scopes are %s", async (_name, scopes) => {
    const db = database();
    const recorded = await recordGrantedScopes({
      shopDomain: "one.myshopify.com", sessionId: "offline_one.myshopify.com", scopes, database: db,
    });
    expect(recorded).toBe(false);
    expect(db.session.updateMany).not.toHaveBeenCalled();
  });
});
