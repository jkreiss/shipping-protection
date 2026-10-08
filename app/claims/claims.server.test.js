import { expect, test, vi } from "vitest";
import { readClaimsOverview } from "./claims.server";

test("claims retrieve Shopify timezone and scope records to the authenticated tenant", async () => {
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", configuration: {} }) },
    claim: { findMany: vi.fn().mockResolvedValue([{
      id: "c1", type: "LOST", status: "SUBMITTED", submittedAt: new Date("2026-03-09T07:30:00Z"),
      protectionPurchase: { order: { name: "#1001", shopifyOrderId: "gid://shopify/Order/1" } },
    }]) },
  };
  const admin = { graphql: vi.fn(async (query) => {
    expect(query.replace(/#[^\n]*/g, "").trim()).toMatch(/^query\s/);
    expect(query).toContain("ianaTimezone");
    return { json: async () => ({ data: { shop: { ianaTimezone: "America/Los_Angeles" } } }) };
  }) };
  const result = await readClaimsOverview(admin, "one.myshopify.com", database);
  expect(result.timeZone).toBe("America/Los_Angeles");
  expect(result.claims[0].submittedAt).toBe("2026-03-09T07:30:00.000Z");
  expect(database.shop.findUnique.mock.calls.every(([query]) => query.where.shopDomain === "one.myshopify.com")).toBe(true);
  expect(database.claim.findMany.mock.calls[0][0]).toMatchObject({ where: { shopId: "shop-1" }, take: 50 });
});

test("claims reject an unavailable tenant before reading Shopify or claims", async () => {
  const admin = { graphql: vi.fn() };
  const database = { shop: { findUnique: vi.fn().mockResolvedValue(null) }, claim: { findMany: vi.fn() } };
  await expect(readClaimsOverview(admin, "missing.myshopify.com", database)).rejects.toThrow("not installed");
  expect(admin.graphql).not.toHaveBeenCalled();
  expect(database.claim.findMany).not.toHaveBeenCalled();
});
