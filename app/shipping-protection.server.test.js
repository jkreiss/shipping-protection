import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCore: vi.fn(),
  findProduct: vi.fn(),
  buildChecks: vi.fn(),
  ensureInstalledShop: vi.fn(),
  getActivePricingRule: vi.fn(),
  reconcilePublishedPricingRule: vi.fn(),
  getShopConfiguration: vi.fn(),
  repairProduct: vi.fn(),
  loadProduct: vi.fn(),
  ensureTransform: vi.fn(),
  publishSnapshot: vi.fn(),
  createAndPublishPricingRule: vi.fn(),
  enableShopProtection: vi.fn(),
  disableShopProtection: vi.fn(),
  withShopSettingsLock: vi.fn((_shopDomain, run) => run()),
  writeJsonMetafield: vi.fn(),
  disableKnownConfiguration: vi.fn(),
  activateProduct: vi.fn(),
  assertFunctionDeployed: vi.fn(),
}));

vi.mock("./shopify/protection-admin.server", async (importOriginal) => ({
  sameContract: (await importOriginal()).sameContract,
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
vi.mock("./shop.server", async (importOriginal) => ({
  ...await importOriginal(),
  ensureInstalledShop: mocks.ensureInstalledShop,
  withShopSettingsLock: mocks.withShopSettingsLock,
}));
vi.mock("./pricing-rule.server", () => ({
  getActivePricingRule: mocks.getActivePricingRule,
  createAndPublishPricingRule: mocks.createAndPublishPricingRule,
  reconcilePublishedPricingRule: mocks.reconcilePublishedPricingRule,
}));
vi.mock("./merchant/configuration.server", () => ({
  getShopConfiguration: mocks.getShopConfiguration,
  enableShopProtection: mocks.enableShopProtection,
  disableShopProtection: mocks.disableShopProtection,
}));

import { settingsLeaseContext } from "./settings-lease-context.server";
import { activatePricingRule, disableShippingProtection, readShippingProtectionState, setupShippingProtection } from "./shipping-protection.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureInstalledShop.mockReset().mockResolvedValue({ installationGeneration: 0 });
  mocks.disableKnownConfiguration.mockReset();
  mocks.writeJsonMetafield.mockReset();
  mocks.disableShopProtection.mockReset();
  mocks.publishSnapshot.mockReset();
  mocks.reconcilePublishedPricingRule.mockReset();
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
    protectionEnabled: true, protectionRateEditable: true, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
  });
});

const ruleFor = (productId, variantId) => ({
  id: "pricing-1", shopId: "shop-1", ruleId: "rule-1", version: 3, productId, variantId,
  rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: new Date("2026-09-01T00:00:00Z"),
});

describe("turning shipping protection off", () => {
  const contract = { schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1", ruleId: "rule-1", ruleVersion: 3,
    rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: "2026-09-01T00:00:00.000Z" };
  let core;

  beforeEach(async () => {
    core = { ...(await mocks.loadCore()), shopConfig: { ...contract }, transformConfig: { ...contract },
      transform: { id: "transform-1", blockOnFailure: false }, onlineStore: { id: "publication-1" } };
    mocks.loadCore.mockResolvedValue(core);
    mocks.getActivePricingRule.mockResolvedValue(ruleFor(contract.productId, contract.variantId));
    mocks.disableKnownConfiguration.mockImplementation(async (_admin, target, current) => {
      target.shopConfig = { ...current, enabled: false };
      target.transformConfig = { ...current, enabled: false };
    });
    mocks.disableShopProtection.mockImplementation(async () => {
      const settings = { ...(await mocks.getShopConfiguration()), protectionEnabled: false };
      mocks.getShopConfiguration.mockResolvedValue(settings);
      return settings;
    });
  });

  test("switches off checkout and pricing under the same merchant settings lock", async () => {
    const state = await disableShippingProtection({}, "one.myshopify.com");

    expect(state.protectionOff).toBe(true);
    expect(state.configuration.protectionEnabled).toBe(false);
    expect(state.pricing).toMatchObject({ ruleId: "rule-1", rateBasisPoints: 40 });
    expect(mocks.withShopSettingsLock).toHaveBeenCalledWith("one.myshopify.com", expect.any(Function));
    expect(mocks.disableKnownConfiguration).toHaveBeenCalledWith({}, core, contract);
    expect(mocks.disableShopProtection).toHaveBeenCalledWith("one.myshopify.com");
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
    expect(mocks.repairProduct).not.toHaveBeenCalled();
  });

  test("rejects a shop mismatch before changing Shopify or merchant settings", async () => {
    await expect(disableShippingProtection({}, "two.myshopify.com"))
      .rejects.toThrow("Shopify shop identity does not match the session");
    expect(mocks.disableKnownConfiguration).not.toHaveBeenCalled();
    expect(mocks.disableShopProtection).not.toHaveBeenCalled();
  });

  test("leaves merchant settings enabled if Shopify rejects the change", async () => {
    mocks.disableKnownConfiguration.mockRejectedValueOnce(new Error("Shopify conflict"));

    await expect(disableShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Shopify conflict");

    expect(mocks.disableShopProtection).not.toHaveBeenCalled();
    expect(core.shopConfig.enabled).toBe(true);
    expect(core.transformConfig.enabled).toBe(true);
  });

  test("allows turning off an existing setup after the store loses checkout eligibility", async () => {
    core.shop.plan.shopifyPlus = false;
    core.shop.features.cartTransform.eligibleOperations.updateOperation = false;
    expect((await disableShippingProtection({}, "one.myshopify.com")).protectionOff).toBe(true);
  });

  test("uses the pricing function's contract when the published copies differ", async () => {
    core.shopConfig = { ...contract, rateBasisPoints: 25 };
    await disableShippingProtection({}, "one.myshopify.com");
    expect(mocks.disableKnownConfiguration).toHaveBeenCalledWith({}, core, contract);
  });

  test("disables the published copy that matches the active pricing rule, not an older one", async () => {
    const newer = { ...contract, ruleId: "rule-4", ruleVersion: 4, rateBasisPoints: 55 };
    core.shopConfig = newer;
    core.transformConfig = contract;
    mocks.getActivePricingRule.mockResolvedValue({
      ...ruleFor(contract.productId, contract.variantId), ruleId: "rule-4", version: 4, rateBasisPoints: 55,
    });
    await disableShippingProtection({}, "one.myshopify.com");
    expect(mocks.disableKnownConfiguration).toHaveBeenCalledWith({}, core, newer);
  });

  test("recovers a missing configuration from the merchant's existing pricing rule", async () => {
    core.shopConfig = null;
    core.transformConfig = null;
    await disableShippingProtection({}, "one.myshopify.com");
    expect(core.shopConfig).toEqual({ ...contract, enabled: false });
  });

  test("does not claim success without any configuration or saved pricing rule", async () => {
    core.shopConfig = null;
    core.transformConfig = null;
    mocks.getActivePricingRule.mockResolvedValue(null);
    await expect(disableShippingProtection({}, "one.myshopify.com")).rejects.toThrow("configuration");
    expect(mocks.disableShopProtection).not.toHaveBeenCalled();
  });

  test("retries safely without creating resources or changing the rate", async () => {
    await disableShippingProtection({}, "one.myshopify.com");
    const state = await disableShippingProtection({}, "one.myshopify.com");
    expect(state.protectionOff).toBe(true);
    expect(state.pricing.rateBasisPoints).toBe(40);
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
    expect(mocks.ensureTransform).not.toHaveBeenCalled();
  });

  test("shows published protection as off if its local settings write failed", async () => {
    mocks.disableShopProtection.mockRejectedValueOnce(new Error("Database unavailable"));
    mocks.buildChecks.mockReturnValue([
      { id: "checkoutConfig", ok: false }, { id: "transformConfig", ok: false },
    ]);
    await expect(disableShippingProtection({}, "one.myshopify.com")).rejects.toThrow("Database unavailable");
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(state.protectionOff).toBe(true);
    expect(state.configuration.protectionEnabled).toBe(false);
  });

  test("keeps the latest published rate when a previous save needs database recovery", async () => {
    mocks.getActivePricingRule.mockResolvedValue({
      ...ruleFor(contract.productId, contract.variantId), ruleId: "old-rule", version: 2, rateBasisPoints: 25,
    });
    mocks.reconcilePublishedPricingRule.mockImplementation(async () => {
      mocks.getActivePricingRule.mockResolvedValue(ruleFor(contract.productId, contract.variantId));
    });

    const state = await disableShippingProtection({}, "one.myshopify.com");

    expect(state.pricing).toMatchObject({ ruleId: "rule-1", ruleVersion: 3, rateBasisPoints: 40 });
  });

  test("restores protection at its saved rate through setup", async () => {
    await disableShippingProtection({}, "one.myshopify.com");
    mocks.repairProduct.mockResolvedValue({ product: { id: contract.productId }, variantId: contract.variantId });
    mocks.ensureTransform.mockResolvedValue({ id: "transform-1" });
    mocks.loadProduct.mockResolvedValue({ status: "UNLISTED", variantsCount: { count: 1 }, variants: { nodes: [{}] } });
    mocks.publishSnapshot.mockImplementation(async (_admin, snapshot) => {
      core.shopConfig = snapshot;
      core.transformConfig = snapshot;
    });
    mocks.enableShopProtection.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });

    const state = await setupShippingProtection({}, "one.myshopify.com");

    expect(mocks.findProduct).toHaveBeenCalledWith({}, contract.productId, {
      recordedProductId: contract.productId,
    });
    expect(state.protectionOff).toBe(false);
    expect(state.configuration.protectionEnabled).toBe(true);
    expect(state.configuration.protectionRateEditable).toBe(false);
    expect(state.pricing.rateBasisPoints).toBe(40);
    expect(core.shopConfig).toEqual(contract);
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
  });
});

describe("merchant rate editing", () => {
  beforeEach(async () => {
    const core = await mocks.loadCore();
    mocks.loadCore.mockResolvedValue({ ...core, transform: { id: "transform-1" } });
    mocks.findProduct.mockResolvedValue({
      id: "gid://shopify/Product/1", title: "Shipping Protection",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/1" }] },
    });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    mocks.createAndPublishPricingRule.mockResolvedValue({ ruleId: "new-rule" });
    mocks.loadCore.mockClear();
  });

  test("rejects a locked store before publishing any pricing changes", async () => {
    mocks.getShopConfiguration.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    await expect(activatePricingRule({}, "one.myshopify.com", 75))
      .rejects.toThrow("managed by the app operator");
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
    expect(mocks.loadCore).not.toHaveBeenCalled();
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(state.pricing.rateBasisPoints).toBe(40);
    expect(state.configuration.protectionEnabled).toBe(true);
    expect(state.configuration.protectionRateEditable).toBe(false);
  });

  test("allows an editable store to publish a new rate", async () => {
    const result = await activatePricingRule({}, "one.myshopify.com", 75);
    expect(result.ruleId).toBe("new-rule");
    expect(mocks.createAndPublishPricingRule).toHaveBeenCalledWith(expect.objectContaining({
      shopDomain: "one.myshopify.com", rateBasisPoints: 75,
    }));
  });

  test("loads the shop and the product once before publishing, then re-reads to verify", async () => {
    await activatePricingRule({}, "one.myshopify.com", 75);
    // One load to check and publish, one to verify what was published.
    expect(mocks.loadCore).toHaveBeenCalledTimes(2);
    expect(mocks.findProduct).toHaveBeenCalledTimes(2);
  });

  test("denies rate changes when the permission is missing", async () => {
    mocks.getShopConfiguration.mockResolvedValue({
      protectionEnabled: true, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    await expect(activatePricingRule({}, "one.myshopify.com", 75))
      .rejects.toThrow("managed by the app operator");
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
  });
});

describe("shipping protection shop isolation", () => {
  test("rejects a session shop that differs from Shopify's response", async () => {
    await expect(readShippingProtectionState({}, "two.myshopify.com"))
      .rejects.toThrow("Shopify shop identity does not match the session");
    expect(mocks.ensureInstalledShop.mock.calls).toEqual([["two.myshopify.com"]]);
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

describe("recovering the protection product", () => {
  const recorded = "gid://shopify/Product/7";

  test("a state read looks for the product the active pricing rule recorded", async () => {
    mocks.getActivePricingRule.mockResolvedValue(ruleFor(recorded, "gid://shopify/ProductVariant/7"));
    await readShippingProtectionState({}, "one.myshopify.com");
    expect(mocks.findProduct).toHaveBeenCalledWith({}, "gid://shopify/Product/1", {
      recordedProductId: recorded,
    });
  });

  test("a rate change looks for the product the active pricing rule recorded", async () => {
    const core = await mocks.loadCore();
    mocks.loadCore.mockResolvedValue({ ...core, transform: { id: "transform-1" } });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    mocks.findProduct.mockResolvedValue({
      id: "gid://shopify/Product/1", title: "Shipping Protection",
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/1" }] },
    });
    mocks.createAndPublishPricingRule.mockResolvedValue({ ruleId: "new-rule" });
    await activatePricingRule({}, "one.myshopify.com", 75);
    expect(mocks.findProduct).toHaveBeenCalledWith({}, "gid://shopify/Product/1", {
      recordedProductId: "gid://shopify/Product/1",
    });
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

  test("fails readiness when the active rule's rate differs from the published one", async () => {
    const core = await mocks.loadCore();
    mocks.loadCore.mockResolvedValue({
      ...core,
      shopConfig: {
        schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1", ruleId: "rule-2", ruleVersion: 4,
        rateBasisPoints: 25, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: "2026-09-02T00:00:00.000Z",
      },
    });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(pricingCheck(state).ok).toBe(false);
    expect(state.ready).toBe(false);
    // The dashboard shows what checkout charges, not the database's rule.
    expect(state.pricing).toMatchObject({ ruleId: "rule-2", ruleVersion: 4, rateBasisPoints: 25 });
  });

  test("passes readiness when a schema 2 rule matches the published one", async () => {
    const core = await mocks.loadCore();
    mocks.loadCore.mockResolvedValue({
      ...core,
      shopConfig: {
        schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1", ruleId: "rule-1", ruleVersion: 3,
        rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: "2026-09-01T00:00:00.000Z",
      },
    });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    const state = await readShippingProtectionState({}, "one.myshopify.com");
    expect(pricingCheck(state).ok).toBe(true);
    expect(state.pricing).toMatchObject({ ruleId: "rule-1", rateBasisPoints: 40 });
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

  test("can update setup for a locked store without changing its existing rate", async () => {
    mocks.getShopConfiguration.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.enableShopProtection.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/1" });
    mocks.getActivePricingRule.mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    const state = await setupShippingProtection({}, "one.myshopify.com");
    expect(state.configuration.protectionRateEditable).toBe(false);
    expect(state.pricing.rateBasisPoints).toBe(40);
    expect(mocks.publishSnapshot).toHaveBeenCalledWith({}, expect.objectContaining({ rateBasisPoints: 40 }));
    expect(mocks.createAndPublishPricingRule).not.toHaveBeenCalled();
  });

  test("preserves a locked store's published rate when its database rule needs recovery", async () => {
    mocks.getShopConfiguration.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.enableShopProtection.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/1" });
    mocks.getActivePricingRule.mockResolvedValueOnce(null)
      .mockResolvedValue(ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"));
    const state = await setupShippingProtection({}, "one.myshopify.com");
    expect(mocks.createAndPublishPricingRule).toHaveBeenCalledWith(expect.objectContaining({ rateBasisPoints: 40 }));
    expect(state.configuration.protectionRateEditable).toBe(false);
  });

  test("recovers the rate checkout charges when the published copies differ and no active rule exists", async () => {
    const core = await mocks.loadCore();
    const recovered = {
      ...core,
      transformConfig: { ...core.shopConfig, rateBasisPoints: 80 },
    };
    mocks.loadCore.mockResolvedValue(recovered);
    // Publishing replaces both published copies, as it does in Shopify.
    mocks.createAndPublishPricingRule.mockImplementation(async ({ rateBasisPoints }) => {
      recovered.shopConfig = { ...recovered.shopConfig, rateBasisPoints };
      recovered.transformConfig = { ...recovered.shopConfig };
    });
    mocks.getShopConfiguration.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.enableShopProtection.mockResolvedValue({
      protectionEnabled: true, protectionRateEditable: false, attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    mocks.repairProduct.mockResolvedValue({ product: { id: "gid://shopify/Product/1" }, variantId: "gid://shopify/ProductVariant/1" });
    mocks.getActivePricingRule.mockResolvedValueOnce(null)
      .mockResolvedValue({ ...ruleFor("gid://shopify/Product/1", "gid://shopify/ProductVariant/1"), rateBasisPoints: 80 });
    await setupShippingProtection({}, "one.myshopify.com");
    expect(mocks.createAndPublishPricingRule).toHaveBeenCalledWith(expect.objectContaining({ rateBasisPoints: 80 }));
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

  test("still disables a partial setup after the settings lease is lost", async () => {
    const disabled = { ...liveContract, enabled: false };
    mocks.loadCore.mockResolvedValue(coreWith({ shopConfig: disabled, transformConfig: disabled }));
    const controller = new AbortController();
    const lease = { shopDomain: "one.myshopify.com", signal: controller.signal, assertHeld: async () => {} };
    const lost = new Error("This settings change was interrupted.");
    mocks.createAndPublishPricingRule.mockImplementationOnce(async () => {
      controller.abort(lost);
      throw lost;
    });
    // Like adminGraphql, writes made inside an aborted lease are refused.
    const afterLoss = [];
    mocks.writeJsonMetafield.mockImplementation(async (_admin, ownerId) => {
      const store = settingsLeaseContext.getStore();
      if (controller.signal.aborted) afterLoss.push({ ownerId, inLease: Boolean(store) });
      if (store?.signal.aborted) throw store.signal.reason;
    });

    await expect(settingsLeaseContext.run(lease, () => setupShippingProtection({}, "one.myshopify.com"))).rejects.toBe(lost);

    expect(afterLoss).toEqual([
      { ownerId: "gid://shopify/Shop/1", inLease: false },
      { ownerId: "transform-1", inLease: false },
    ]);
  });
});


describe("installation generation of a fetched protection snapshot", () => {
  test("captures the generation before Shopify fetch and rejects a reinstall during it", async () => {
    const core = await mocks.loadCore();
    let generation = 0;
    mocks.ensureInstalledShop.mockImplementation(async () => ({ installationGeneration: generation }));
    mocks.loadCore.mockImplementationOnce(async () => {
      generation = 2;
      return { ...core, shopConfig: { ...core.shopConfig, schemaVersion: 2 }, transformConfig: { ...core.shopConfig, schemaVersion: 2 } };
    });
    await expect(readShippingProtectionState({}, "one.myshopify.com")).rejects.toThrow(/access|installation|Installed/i);
    expect(mocks.reconcilePublishedPricingRule).not.toHaveBeenCalled();
  });
});
