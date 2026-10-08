import { describe, expect, test, vi } from "vitest";
import {
  createAndPublishPricingRule,
  getActivePricingRule,
  reconcilePublishedPricingRule,
} from "./pricing-rule.server";

const shopDomain = "one.myshopify.com";
const productId = "gid://shopify/Product/1";
const variantId = "gid://shopify/ProductVariant/2";
const fixedNow = new Date("2026-09-23T00:00:00Z");

function inMemoryDatabase() {
  const state = {
    shop: {
      id: "shop-1",
      shopDomain,
      activePricingRuleId: null,
      installationState: "INSTALLED",
      installationGeneration: 0,
    },
    rules: [],
    failFinalization: false,
  };

  const shop = {
    upsert: vi.fn(async () => state.shop),
    updateMany: vi.fn(async ({ where }) => ({
      count:
        state.shop.installationState === where.installationState &&
        state.shop.installationGeneration === where.installationGeneration
          ? 1
          : 0,
    })),
    update: vi.fn(async ({ data }) => {
      Object.assign(state.shop, data);
      return state.shop;
    }),
    findUnique: vi.fn(async ({ where, include }) => {
      const found = where.shopDomain
        ? where.shopDomain === state.shop.shopDomain
        : where.id === state.shop.id;
      if (!found) return null;
      if (!include?.activePricingRule) return state.shop;
      return {
        ...state.shop,
        activePricingRule:
          state.rules.find(({ id }) => id === state.shop.activePricingRuleId) ??
          state.shop.activePricingRule ??
          null,
      };
    }),
  };
  const pricingRule = {
    findFirst: vi.fn(async ({ where, orderBy }) => {
      const matches = state.rules.filter((rule) =>
        Object.entries(where ?? {}).every(
          ([key, value]) => rule[key] === value,
        ),
      );
      if (orderBy?.version === "desc") {
        return (
          matches.sort((left, right) => right.version - left.version)[0] ?? null
        );
      }
      return matches[0] ?? null;
    }),
    create: vi.fn(async ({ data }) => {
      const rule = { id: `pricing-${state.rules.length + 1}`, ...data };
      state.rules.push(rule);
      return rule;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      for (const rule of state.rules) {
        if (
          rule.shopId === where.shopId &&
          rule.state === where.state &&
          rule.id !== where.id?.not
        ) {
          Object.assign(rule, data);
        }
      }
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }) => {
      const rule = state.rules.find(({ id, shopId }) =>
        where.id_shopId
          ? id === where.id_shopId.id && shopId === where.id_shopId.shopId
          : id === where.id,
      );
      if (!rule) throw new Error("missing rule");
      Object.assign(rule, data);
      return rule;
    }),
  };
  const database = {
    shop,
    pricingRule,
    $transaction: vi.fn(async (callback) => {
      const isFinalization =
        state.rules.length > 0 &&
        state.rules.some((rule) => rule.state === "PENDING");
      if (state.failFinalization && isFinalization) {
        state.failFinalization = false;
        throw new Error("database finalization interrupted");
      }
      return callback({ shop, pricingRule });
    }),
  };
  return { database, state };
}

function activationOptions(database, publishSnapshot) {
  return {
    admin: {},
    shopDomain,
    productId,
    variantId,
    rateBasisPoints: 25,
    publishSnapshot,
    database,
    now: () => fixedNow,
    createRuleId: () => "rule-1",
  };
}

describe("pricing rule publication", () => {
  test("does not publish for an uninstalled shop", async () => {
    const { database, state } = inMemoryDatabase();
    state.shop.installationState = "UNINSTALLED";
    const publish = vi.fn(async () => {});
    await expect(
      createAndPublishPricingRule(activationOptions(database, publish)),
    ).rejects.toThrow();
    expect(state.rules).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  test.each(["uninstall", "reinstall"])(
    "cannot finalize after %s during publication",
    async (transition) => {
      const { database, state } = inMemoryDatabase();
      await expect(
        createAndPublishPricingRule(
          activationOptions(database, async () => {
            state.shop.installationGeneration +=
              transition === "reinstall" ? 2 : 1;
            state.shop.installationState =
              transition === "reinstall" ? "INSTALLED" : "UNINSTALLED";
          }),
        ),
      ).rejects.toThrow();
      expect(state.rules[0].state).toBe("PENDING");
      expect(state.shop.activePricingRuleId).toBeNull();
    },
  );

  test("retries a serialization conflict while creating a pending rule", async () => {
    const { database, state } = inMemoryDatabase();
    database.$transaction.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { code: "P2034" }),
    );
    const publish = vi.fn(async () => {});
    const result = await createAndPublishPricingRule(
      activationOptions(database, publish),
    );
    expect(result.rule.state).toBe("ACTIVE");
    expect(state.rules).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  test("publishes before making the rule active locally", async () => {
    const { database, state } = inMemoryDatabase();
    const publishSnapshot = vi.fn(async (_admin, snapshot) => {
      expect(state.rules[0].state).toBe("PENDING");
      expect(snapshot).toMatchObject({
        schemaVersion: 2,
        ruleId: "rule-1",
        ruleVersion: 1,
        rateBasisPoints: 25,
      });
    });
    const result = await createAndPublishPricingRule(
      activationOptions(database, publishSnapshot),
    );
    expect(publishSnapshot).toHaveBeenCalledOnce();
    expect(result.rule.state).toBe("ACTIVE");
    expect(state.shop.activePricingRuleId).toBe(result.rule.id);
    expect(state.shop.activePricingRuleShopId).toBe(state.shop.id);
  });

  test("marks the pending rule failed when Shopify rejects the write", async () => {
    const { database, state } = inMemoryDatabase();
    await expect(
      createAndPublishPricingRule(
        activationOptions(database, async () => {
          throw new Error("compare digest conflict\nwith details");
        }),
      ),
    ).rejects.toThrow("compare digest conflict");
    expect(state.rules[0]).toMatchObject({
      state: "FAILED",
      failureReason: "compare digest conflict with details",
    });
  });

  test("reconciles an interrupted local finalization from Shopify's snapshot", async () => {
    const { database, state } = inMemoryDatabase();
    state.failFinalization = true;
    let publishedSnapshot;
    await expect(
      createAndPublishPricingRule(
        activationOptions(database, async (_admin, snapshot) => {
          publishedSnapshot = snapshot;
        }),
      ),
    ).rejects.toThrow("database finalization interrupted");
    expect(state.rules[0].state).toBe("PENDING");

    state.failFinalization = false;
    const reconciled = await reconcilePublishedPricingRule(
      shopDomain,
      publishedSnapshot,
      database,
    );
    expect(reconciled.state).toBe("ACTIVE");
    expect(state.shop.activePricingRuleId).toBe(reconciled.id);
  });

  test("recovers a rule marked failed when Shopify applied it anyway", async () => {
    const { database, state } = inMemoryDatabase();
    let publishedSnapshot;
    await expect(
      createAndPublishPricingRule(
        activationOptions(database, async (_admin, snapshot) => {
          publishedSnapshot = snapshot;
          throw new Error("request timed out");
        }),
      ),
    ).rejects.toThrow("request timed out");
    expect(state.rules[0].state).toBe("FAILED");

    const reconciled = await reconcilePublishedPricingRule(
      shopDomain,
      publishedSnapshot,
      database,
    );
    expect(reconciled).toMatchObject({
      state: "ACTIVE",
      failedAt: null,
      failureReason: null,
    });
    expect(state.shop.activePricingRuleId).toBe(reconciled.id);
  });

  test("does not roll the database back to an older interrupted rule", async () => {
    const { database, state } = inMemoryDatabase();
    state.failFinalization = true;
    let firstSnapshot;
    await expect(
      createAndPublishPricingRule(
        activationOptions(database, async (_admin, snapshot) => {
          firstSnapshot = snapshot;
        }),
      ),
    ).rejects.toThrow("database finalization interrupted");
    expect(state.rules[0].state).toBe("PENDING");

    const second = await createAndPublishPricingRule({
      ...activationOptions(database, async () => {}),
      rateBasisPoints: 40,
      createRuleId: () => "rule-2",
    });
    expect(second.rule.version).toBe(2);

    expect(
      await reconcilePublishedPricingRule(shopDomain, firstSnapshot, database),
    ).toBeNull();
    expect(state.shop.activePricingRuleId).toBe(second.rule.id);
    expect(state.rules[1].state).toBe("ACTIVE");
  });

  test("does not roll the database back to an older rule marked failed", async () => {
    const { database, state } = inMemoryDatabase();
    let firstSnapshot;
    await expect(
      createAndPublishPricingRule(
        activationOptions(database, async (_admin, snapshot) => {
          firstSnapshot = snapshot;
          throw new Error("request timed out");
        }),
      ),
    ).rejects.toThrow("request timed out");
    expect(state.rules[0].state).toBe("FAILED");

    const second = await createAndPublishPricingRule({
      ...activationOptions(database, async () => {}),
      rateBasisPoints: 40,
      createRuleId: () => "rule-2",
    });

    expect(
      await reconcilePublishedPricingRule(shopDomain, firstSnapshot, database),
    ).toBeNull();
    expect(state.shop.activePricingRuleId).toBe(second.rule.id);
    expect(state.rules[0].state).toBe("FAILED");
  });

  test("does not reactivate a superseded rule", async () => {
    const { database, state } = inMemoryDatabase();
    let publishedSnapshot;
    await createAndPublishPricingRule(
      activationOptions(database, async (_admin, snapshot) => {
        publishedSnapshot = snapshot;
      }),
    );
    state.rules[0].state = "SUPERSEDED";
    expect(
      await reconcilePublishedPricingRule(
        shopDomain,
        publishedSnapshot,
        database,
      ),
    ).toBeNull();
  });

  test("does not reconcile a snapshot into a different shop", async () => {
    const { database } = inMemoryDatabase();
    expect(
      await reconcilePublishedPricingRule(
        "two.myshopify.com",
        {
          schemaVersion: 2,
          ruleId: "rule-1",
          ruleVersion: 1,
          rateBasisPoints: 25,
          basis: "SHIPPABLE_PRE_DISCOUNT",
        },
        database,
      ),
    ).toBeNull();
  });

  test("returns no active rule for an unknown shop", async () => {
    const { database } = inMemoryDatabase();
    expect(
      await getActivePricingRule("missing.myshopify.com", database),
    ).toBeNull();
  });

  test("does not return an active rule from another shop", async () => {
    const { database, state } = inMemoryDatabase();
    state.shop.activePricingRule = { id: "other-rule", shopId: "shop-2" };
    expect(await getActivePricingRule(shopDomain, database)).toBeNull();
  });
});
