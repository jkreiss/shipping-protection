import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCore: vi.fn(),
  findProduct: vi.fn(),
  buildChecks: vi.fn(),
  ensureInstalledShop: vi.fn(),
  getActivePricingRule: vi.fn(),
  getShopConfiguration: vi.fn(),
  repairProduct: vi.fn(),
  loadProduct: vi.fn(),
  ensureTransform: vi.fn(),
  publishSnapshot: vi.fn(),
  createAndPublishPricingRule: vi.fn(),
  enableShopProtection: vi.fn(),
  writeJsonMetafield: vi.fn(),
  disableKnownConfiguration: vi.fn(),
  activateProduct: vi.fn(),
  assertFunctionDeployed: vi.fn(),
}));

vi.mock("./shopify/protection-admin.server", () => ({
  loadCore: mocks.loadCore,
  loadProduct: mocks.loadProduct,
  findProduct: mocks.findProduct,
  buildChecks: mocks.buildChecks,
  writeJsonMetafield: mocks.writeJsonMetafield,
  disableKnownConfiguration: mocks.disableKnownConfiguration,
  repairProduct: mocks.repairProduct,
  ensureTransform: mocks.ensureTransform,
  activateProduct: mocks.activateProduct,
  assertFunctionDeployed: mocks.assertFunctionDeployed,
  publishSnapshot: mocks.publishSnapshot,
  productIsPublished: () => true,
  variantIsReady: () => true,
  protectionAdminConstants: {
    productTitle: "Shipping Protection",
    productHandle: "shipping-protection",
    functionHandle: "shipping-protection-transform",
    shopConfigKey: "shipping_protection_config",
    functionConfigKey: "function-configuration",
  },
}));
vi.mock("./shop.server", () => ({
  ensureInstalledShop: mocks.ensureInstalledShop,
  withShopSettingsLock: (_shopDomain, run) => run(),
}));
vi.mock("./pricing-rule.server", () => ({
  getActivePricingRule: mocks.getActivePricingRule,
  createAndPublishPricingRule: mocks.createAndPublishPricingRule,
  reconcilePublishedPricingRule: vi.fn(),
}));
vi.mock("./merchant/configuration.server", () => ({
  getShopConfiguration: mocks.getShopConfiguration,
  enableShopProtection: mocks.enableShopProtection,
}));

import { readShippingProtectionState, setupShippingProtection } from "./shipping-protection.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadCore.mockResolvedValue({
    shop: {
      id: "gid://shopify/Shop/1", name: "One", myshopifyDomain: "one.myshopify.com",
      plan: { shopifyPlus: true },
      features: { cartTransform: { eligibleOperations: { updateOperation: true } } },
    },
    shopConfig: { schemaVersion: 1, enabled: true,
      productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1", rateBasisPoints: 25,
      basis: "SHIPPABLE_PRE_DISCOUNT" },
    transformConfig: null,
  });
  mocks.findProduct.mockResolvedValue(null);
  mocks.buildChecks.mockReturnValue([{ id: "setup", ok: true }]);
  mocks.getActivePricingRule.mockResolvedValue(null);
  mocks.getShopConfiguration.mockResolvedValue({
    protectionEnabled: true, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
  });
});

const ruleFor = (productId, variantId) => ({
  id: "pricing-1", shopId: "shop-1", ruleId: "rule-1", version: 3, productId, variantId,
  rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: new Date("2026-09-01T00:00:00Z"),
});

describe("shipping protection shop isolation", () => {
  test("rejects a session shop that differs from Shopify's response", async () => {
    await expect(readShippingProtectionState({}, "two.myshopify.com"))
      .rejects.toThrow("Shopify shop identity does not match the session");
    expect(mocks.ensureInstalledShop).not.toHaveBeenCalled();
  });

  test("rejects setup before changing Shopify on an unsupported shop", async () => {
    const core = await mocks.loadCore();
    core.shop.features.cartTransform.eligibleOperations.updateOperation = false;
    mocks.loadCore.mockResolvedValue(core);
    await expect(setupShippingProtection({}, "one.myshopify.com"))
      .rejects.toThrow("doesn't support the checkout protection offer");
    expect(mocks.ensureInstalledShop).not.toHaveBeenCalled();
  });
});

describe("pricing rule health", () => {
  const pricingCheck = (state) => state.checks.find(({ id }) => id === "pricing-rule");

  test("passes when the active rule prices the configured product", async () => {
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(pricingCheck(state).ok).toBe(true);
    expect(state.ready).toBe(true);
  });

  // Orders are recognised as protected by the rule's variant, so a legacy
  // setup without a rule would record no protection until it is repaired.
  test("asks a legacy setup without a pricing rule to repair", async () => {
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(mocks.getShopConfiguration).toHaveBeenCalledWith("one.myshopify.com");
    expect(pricingCheck(state).ok).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.configuration.protectionEnabled).toBe(false);
  });

  test("asks for repair when the rule is on a replaced variant", async () => {
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/9"));
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(pricingCheck(state).ok).toBe(false);
  });
});

describe("setup republishing", () => {
  beforeEach(() => {
    const core = {
      shop: {
        id: "gid://shopify/Shop/1", name: "One", myshopifyDomain: "one.myshopify.com",
        plan: { shopifyPlus: true },
        features: { cartTransform: { eligibleOperations: { updateOperation: true } } },
      },
      shopConfig: { schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1",
        ruleId: "rule-1", ruleVersion: 3, rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT",
        effectiveAt: "2026-09-01T00:00:00.000Z" },
      transformConfig: null,
      transform: { id: "transform-1" },
      onlineStore: { id: "publication-1" },
    };
    mocks.loadCore.mockResolvedValue(core);
    mocks.ensureTransform.mockResolvedValue({ id: "transform-1" });
    mocks.loadProduct.mockResolvedValue({
      status: "UNLISTED", variantsCount: { count: 1 }, variants: { nodes: [{}] },
    });
    mocks.enableShopProtection.mockResolvedValue({
      protectionEnabled: true, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
  });

  test("republishes the active rule when the product is unchanged", async () => {
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/1" });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    await setupShippingProtection({}, "one.myshopify.com");
    expect(mocks.publishSnapshot).toHaveBeenCalledWith({}, expect.objectContaining({
      ruleId: "rule-1", variantId: "gid://shopify/ProductVariant/1", rateBasisPoints: 40,
    }));
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
  });

  test("publishes a new rule at the same rate when repair replaced the variant", async () => {
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/2" });
    mocks.getActivePricingRule
      .mockResolvedValueOnce(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"))
      .mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/2"));
    mocks.loadCore
      .mockResolvedValueOnce(await mocks.loadCore())
      .mockResolvedValue({ ...(await mocks.loadCore()), shopConfig: {
        ...(await mocks.loadCore()).shopConfig, variantId: "gid://shopify/ProductVariant/2" } });
    await setupShippingProtection({}, "one.myshopify.com");
    expect(mocks.createAndPublishPricingRule).toHaveBeenCalledWith(expect.objectContaining({
      productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/2", rateBasisPoints: 40,
    }));
    expect(mocks.publishSnapshot).not.toHaveBeenCalled();
  });
});

describe("repairing a live store", () => {
  const liveContract = { schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1", ruleId: "rule-1", ruleVersion: 3, rateBasisPoints: 40,
    basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: "2026-09-01T00:00:00.000Z" };
  const coreWith = (overrides) => ({
    shop: {
      id: "gid://shopify/Shop/1", name: "One", myshopifyDomain: "one.myshopify.com",
      plan: { shopifyPlus: true },
      features: { cartTransform: { eligibleOperations: { updateOperation: true } } },
    },
    shopConfig: liveContract,
    transformConfig: liveContract,
    transform: { id: "transform-1", blockOnFailure: false },
    onlineStore: { id: "publication-1" },
    ...overrides,
  });
  const disabledWrites = () => mocks.writeJsonMetafield.mock.calls
    .filter(([, , , value]) => value?.enabled === false);

  beforeEach(() => {
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/1" });
    mocks.ensureTransform.mockResolvedValue({ id: "transform-1" });
  });

  test("keeps protection enabled when repair fails part way", async () => {
    mocks.loadCore.mockResolvedValue(coreWith());
    mocks.activateProduct.mockRejectedValueOnce(new Error("Shopify is unavailable"));

    await expect(setupShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Shopify is unavailable");

    expect(mocks.disableKnownConfiguration).not.toHaveBeenCalled();
    expect(disabledWrites()).toEqual([]);
    expect(mocks.ensureTransform).toHaveBeenCalledWith({}, expect.anything(), liveContract, { overwrite: false });
  });

  test("keeps protection enabled when the final health check fails", async () => {
    mocks.loadCore.mockResolvedValue(coreWith());
    mocks.loadProduct.mockResolvedValue({ status: "UNLISTED", variantsCount: { count: 1 }, variants: { nodes: [{}] } });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    mocks.buildChecks.mockReturnValue([{ id: "transform", ok: false }]);

    await expect(setupShippingProtection({}, "one.myshopify.com")).rejects.toThrow("some checks still fail");

    expect(mocks.disableKnownConfiguration).not.toHaveBeenCalled();
    expect(disabledWrites()).toEqual([]);
  });

  test("stops before changing anything when Online Store is missing", async () => {
    mocks.loadCore.mockResolvedValue(coreWith({ onlineStore: null }));

    await expect(setupShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Online Store sales channel");

    expect(mocks.disableKnownConfiguration).not.toHaveBeenCalled();
    expect(mocks.repairProduct).not.toHaveBeenCalled();
    expect(mocks.writeJsonMetafield).not.toHaveBeenCalled();
  });

  test("stops before changing anything when the Function isn't deployed", async () => {
    mocks.loadCore.mockResolvedValue(coreWith());
    mocks.assertFunctionDeployed.mockImplementationOnce(() => { throw new Error("Deploy the Function"); });

    await expect(setupShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Deploy the Function");

    expect(mocks.repairProduct).not.toHaveBeenCalled();
    expect(mocks.writeJsonMetafield).not.toHaveBeenCalled();
  });

  test("still disables a partial setup on a store that wasn't live", async () => {
    const disabled = { ...liveContract, enabled: false };
    mocks.loadCore.mockResolvedValue(coreWith({ shopConfig: disabled, transformConfig: disabled }));
    mocks.activateProduct.mockRejectedValueOnce(new Error("Shopify is unavailable"));

    await expect(setupShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Shopify is unavailable");

    expect(mocks.disableKnownConfiguration).toHaveBeenCalled();
    expect(mocks.ensureTransform).toHaveBeenCalledWith({}, expect.anything(),
      expect.objectContaining({ enabled: false }), { overwrite: true });
    expect(disabledWrites().length).toBeGreaterThan(0);
  });
});
