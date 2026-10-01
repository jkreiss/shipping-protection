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
}));

vi.mock("./shopify/protection-admin.server", () => ({
  loadCore: mocks.loadCore,
  loadProduct: mocks.loadProduct,
  findProduct: mocks.findProduct,
  buildChecks: mocks.buildChecks,
  writeJsonMetafield: vi.fn(),
  disableKnownConfiguration: vi.fn(),
  repairProduct: mocks.repairProduct,
  ensureTransform: mocks.ensureTransform,
  activateProduct: vi.fn(),
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
vi.mock("./shop.server", () => ({ ensureInstalledShop: mocks.ensureInstalledShop }));
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
      .rejects.toThrow("cannot use the checkout block");
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
