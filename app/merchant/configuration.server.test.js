import { describe, expect, test, vi } from "vitest";
import {
  disableShopProtection,
  enableShopProtection,
  getShopConfiguration,
} from "./configuration.server";

function database(shop) {
  const db = {
    shop: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          shop && {
            installationState: "INSTALLED",
            installationGeneration: 0,
            ...shop,
          },
        ),
      updateMany: async () => ({ count: 1 }),
    },
    shopConfiguration: {
      upsert: vi.fn(async ({ create, update }) => ({ ...create, ...update })),
    },
  };
  db.$transaction = async (run) => run(db);
  return db;
}

describe("shop configuration persistence", () => {
  test("starts a new merchant disabled", async () => {
    const db = database({
      id: "new",
      configuration: null,
      activePricingRule: null,
    });
    const config = await getShopConfiguration("new.myshopify.com", {
      database: db,
    });
    expect(config).toEqual({ shopId: "new" });
  });

  test("does not infer setup completion from a rule created during setup", async () => {
    const db = database({
      id: "one",
      configuration: null,
      activePricingRule: { shopId: "one", state: "ACTIVE" },
    });
    expect(
      await getShopConfiguration("one.myshopify.com", { database: db }),
    ).toEqual({ shopId: "one" });
  });

  test("does not adopt another merchant's active rule", async () => {
    const db = database({
      id: "one",
      configuration: null,
      activePricingRule: { shopId: "two", state: "ACTIVE" },
    });
    expect(
      await getShopConfiguration("one.myshopify.com", { database: db }),
    ).toEqual({ shopId: "one" });
  });

  test("preserves an existing disabled setting", async () => {
    const existing = {
      shopId: "one",
      protectionEnabled: false,
      attachmentStrategy: "NONE",
    };
    const db = database({
      id: "one",
      configuration: existing,
      activePricingRule: { shopId: "one", state: "ACTIVE" },
    });
    expect(
      await getShopConfiguration("one.myshopify.com", { database: db }),
    ).toBe(existing);
    expect(db.shopConfiguration.upsert).not.toHaveBeenCalled();
  });

  test("enables only the authenticated shop after successful setup", async () => {
    const db = database({ id: "one" });
    await enableShopProtection("one.myshopify.com", db);
    expect(db.shopConfiguration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "one" },
        update: expect.objectContaining({
          protectionEnabled: true,
          attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
        }),
      }),
    );
  });

  test("setup preserves the operator's rate restriction", async () => {
    const existing = {
      shopId: "one",
      protectionEnabled: false,
      protectionRateEditable: false,
    };
    const db = database({ id: "one", configuration: existing });
    db.shopConfiguration.upsert.mockImplementation(async ({ update }) => ({
      ...existing,
      ...update,
    }));
    const config = await enableShopProtection("one.myshopify.com", db);
    expect(config.protectionEnabled).toBe(true);
    expect(config.protectionRateEditable).toBe(false);
  });

  test("turning off protection changes only this merchant's enabled setting", async () => {
    const existing = {
      shopId: "one",
      protectionEnabled: true,
      protectionRateEditable: false,
      stolenCoverageEnabled: true,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    };
    const db = database({ id: "one", configuration: existing });
    db.shopConfiguration.upsert.mockImplementation(async ({ update }) => ({
      ...existing,
      ...update,
    }));

    const config = await disableShopProtection("one.myshopify.com", db);

    expect(config).toEqual({ ...existing, protectionEnabled: false });
    expect(db.shopConfiguration.upsert).toHaveBeenCalledWith({
      where: { shopId: "one" },
      create: {
        shopId: "one",
        protectionEnabled: false,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      },
      update: {
        protectionEnabled: false,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      },
    });
  });

  test("turning off a shop whose strategy is still NONE records the checkout strategy", async () => {
    const existing = {
      shopId: "one",
      protectionEnabled: true,
      attachmentStrategy: "NONE",
    };
    const db = database({ id: "one", configuration: existing });
    db.shopConfiguration.upsert.mockImplementation(async ({ update }) => ({
      ...existing,
      ...update,
    }));

    const config = await disableShopProtection("one.myshopify.com", db);

    // The published offer can only be read as "off" once the strategy is set.
    expect(config).toMatchObject({
      protectionEnabled: false,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
  });

  test("setup turns on the stolen, lost, and damaged flags the US copy names", async () => {
    const db = database({ id: "one" });
    await enableShopProtection("one.myshopify.com", db);
    const { create, update } = db.shopConfiguration.upsert.mock.calls[0][0];
    for (const flags of [create, update]) {
      expect(flags).toMatchObject({
        stolenCoverageEnabled: true,
        lostCoverageEnabled: true,
        damagedCoverageEnabled: true,
      });
    }
  });
});
