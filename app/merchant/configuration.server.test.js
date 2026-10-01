import { describe, expect, test, vi } from "vitest";
import { enableShopProtection, getShopConfiguration } from "./configuration.server";

function database(shop) {
  return {
    shop: { findUnique: vi.fn().mockResolvedValue(shop) },
    shopConfiguration: { upsert: vi.fn(async ({ create, update }) => ({ ...create, ...update })) },
  };
}

describe("shop configuration persistence", () => {
  test("starts a new merchant disabled", async () => {
    const db = database({ id: "new", configuration: null, activePricingRule: null });
    const config = await getShopConfiguration("new.myshopify.com", { database: db });
    expect(config).toEqual({ shopId: "new" });
  });

  test("does not infer setup completion from a rule created during setup", async () => {
    const db = database({ id: "one", configuration: null,
      activePricingRule: { shopId: "one", state: "ACTIVE" } });
    expect(await getShopConfiguration("one.myshopify.com", { database: db }))
      .toEqual({ shopId: "one" });
  });

  test("does not adopt another merchant's active rule", async () => {
    const db = database({ id: "one", configuration: null,
      activePricingRule: { shopId: "two", state: "ACTIVE" } });
    expect(await getShopConfiguration("one.myshopify.com", { database: db }))
      .toEqual({ shopId: "one" });
  });

  test("preserves an existing disabled setting", async () => {
    const existing = { shopId: "one", protectionEnabled: false, attachmentStrategy: "NONE" };
    const db = database({ id: "one", configuration: existing,
      activePricingRule: { shopId: "one", state: "ACTIVE" } });
    expect(await getShopConfiguration("one.myshopify.com", { database: db }))
      .toBe(existing);
    expect(db.shopConfiguration.upsert).not.toHaveBeenCalled();
  });

  test("enables only the authenticated shop after successful setup", async () => {
    const db = database({ id: "one" });
    await enableShopProtection("one.myshopify.com", db);
    expect(db.shopConfiguration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: "one" },
      update: expect.objectContaining({ protectionEnabled: true,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM" }),
    }));
  });
});
