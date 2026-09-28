import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCore: vi.fn(),
  findProduct: vi.fn(),
  buildChecks: vi.fn(),
  ensureInstalledShop: vi.fn(),
  getActivePricingRule: vi.fn(),
  getShopConfiguration: vi.fn(),
}));

vi.mock("./shopify/protection-admin.server", () => ({
  loadCore: mocks.loadCore,
  loadProduct: vi.fn(),
  findProduct: mocks.findProduct,
  buildChecks: mocks.buildChecks,
  writeJsonMetafield: vi.fn(),
  disableKnownConfiguration: vi.fn(),
  repairProduct: vi.fn(),
  ensureTransform: vi.fn(),
  activateProduct: vi.fn(),
  publishSnapshot: vi.fn(),
  productIsPublished: vi.fn(),
  variantIsReady: vi.fn(),
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
  createAndPublishPricingRule: vi.fn(),
  reconcilePublishedPricingRule: vi.fn(),
}));
vi.mock("./merchant/configuration.server", () => ({
  getShopConfiguration: mocks.getShopConfiguration,
  enableShopProtection: vi.fn(),
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
      productId: "product-1", variantId: "variant-1", rateBasisPoints: 25,
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

describe("shipping protection shop isolation and legacy setup", () => {
  test("derives a healthy legacy metafield for the authenticated merchant", async () => {
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(mocks.getShopConfiguration).toHaveBeenCalledWith("one.myshopify.com", {
      legacyReady: true,
    });
    expect(state.configuration.strategy).toBe("CHECKOUT_UI_CART_TRANSFORM");
  });

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
