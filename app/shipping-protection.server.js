import {
  DEFAULT_RATE_BASIS_POINTS,
  PRICING_BASIS,
  formatBasisPoints,
  pricingContractForRule,
} from "./pricing-contract";
import {
  createAndPublishPricingRule,
  getActivePricingRule,
  reconcilePublishedPricingRule,
} from "./pricing-rule.server";
import { ensureInstalledShop, withShopSettingsLock } from "./shop.server";
import { UserFacingError } from "./user-facing-error";
import { enableShopProtection, getShopConfiguration } from "./merchant/configuration.server";
import { observedShopifyCapabilities, resolveConfiguration } from "./merchant/resolve-configuration";
import {
  loadCore, loadProduct, findProduct, buildChecks, writeJsonMetafield,
  disableKnownConfiguration, repairProduct, ensureTransform, activateProduct,
  publishSnapshot, productIsPublished, variantIsReady, protectionAdminConstants,
} from "./shopify/protection-admin.server";

const {
  productTitle: PRODUCT_TITLE,
  productHandle: PRODUCT_HANDLE,
  functionHandle: FUNCTION_HANDLE,
  shopConfigKey: SHOP_CONFIG_KEY,
  functionConfigKey: FUNCTION_CONFIG_KEY,
} = protectionAdminConstants;

function legacyContractFor(productId, variantId, enabled) {
  return {
    schemaVersion: 1, enabled, productId, variantId,
    rateBasisPoints: DEFAULT_RATE_BASIS_POINTS, basis: PRICING_BASIS,
  };
}

function sameContract(left, right, enabled) {
  return Boolean(
    left && right && left.productId === right.productId &&
    left.variantId === right.variantId && left.enabled === enabled &&
    right.enabled === enabled && left.rateBasisPoints === right.rateBasisPoints &&
    left.basis === right.basis && left.schemaVersion === right.schemaVersion &&
    (left.schemaVersion === 1 || (left.ruleId === right.ruleId &&
      left.ruleVersion === right.ruleVersion && left.effectiveAt === right.effectiveAt)),
  );
}

// Orders are recognised as protected by the active rule's variant, so the rule
// must describe the product checkout actually sells. A legacy setup without a
// rule, or a rule left on a replaced product, needs a setup update to publish one.
function pricingRuleCheck(seed, activeRule) {
  return {
    id: "pricing-rule",
    label: "Pricing is linked to the current protection product",
    ok: !seed || Boolean(activeRule &&
      activeRule.productId === seed.productId && activeRule.variantId === seed.variantId),
  };
}

export async function readShippingProtectionState(admin, shopDomain) {
  const core = await loadCore(admin);
  const domain = shopDomain ?? core.shop.myshopifyDomain;
  if (domain !== core.shop.myshopifyDomain) throw new Error("Shopify shop identity does not match the session.");
  await ensureInstalledShop(domain, core.shop.id);
  if (
    core.shopConfig?.schemaVersion === 2 &&
    sameContract(core.shopConfig, core.transformConfig, true)
  ) {
    await reconcilePublishedPricingRule(domain, core.shopConfig);
  }
  const seed = core.shopConfig ?? core.transformConfig;
  const product = await findProduct(admin, seed?.productId);
  const activeRule = await getActivePricingRule(domain);
  const checks = [...buildChecks(core, product), pricingRuleCheck(seed, activeRule)];
  const healthReady = checks.every(({ ok }) => ok);
  const settings = await getShopConfiguration(domain);
  const capabilities = observedShopifyCapabilities(core.shop);
  const configuration = resolveConfiguration(
    settings,
    capabilities,
    healthReady,
  );

  return {
    shopName: core.shop.name,
    ready: healthReady,
    configuration,
    capabilities,
    configuredStrategy: settings.attachmentStrategy,
    checks,
    product: product
      ? {
          id: product.id,
          title: product.title,
          status: product.status,
          onlineStoreUrl: product.onlineStoreUrl,
        }
      : null,
    functionHandle: FUNCTION_HANDLE,
    pricing: activeRule
      ? {
          ruleId: activeRule.ruleId,
          ruleVersion: activeRule.version,
          rateBasisPoints: activeRule.rateBasisPoints,
          percentage: formatBasisPoints(activeRule.rateBasisPoints),
        }
      : seed
        ? {
            ruleId: seed.ruleId ?? null,
            ruleVersion: seed.ruleVersion ?? null,
            rateBasisPoints: seed.rateBasisPoints,
            percentage: formatBasisPoints(seed.rateBasisPoints),
          }
        : null,
  };
}

// Setup and rate changes each publish pricing to Shopify and then record it,
// so they run one at a time per shop.
export function activatePricingRule(admin, shopDomain, rateBasisPoints) {
  return withShopSettingsLock(shopDomain, () => publishRate(admin, shopDomain, rateBasisPoints));
}

export function setupShippingProtection(admin, shopDomain) {
  return withShopSettingsLock(shopDomain, () => runSetup(admin, shopDomain));
}

async function publishRate(
  admin,
  shopDomain,
  rateBasisPoints,
) {
  const settings = await getShopConfiguration(shopDomain);
  if (settings.protectionRateEditable !== true) {
    throw new UserFacingError("This store's protection rate is managed by the app operator.");
  }
  const core = await loadCore(admin);
  if (shopDomain !== core.shop.myshopifyDomain) throw new Error("Shopify shop identity does not match the session.");
  const capabilities = observedShopifyCapabilities(core.shop);
  if (!capabilities.checkoutUiSupported || !capabilities.cartTransformUpdateSupported) {
    throw new UserFacingError("This store's Shopify plan doesn't support the checkout protection offer.");
  }
  const current = await readShippingProtectionState(admin, shopDomain);
  if (!current.configuration.protectionEnabled) {
    throw new UserFacingError("Set up protection before changing the rate.");
  }
  const product = await findProduct(
    admin,
    core.shopConfig?.productId ?? core.transformConfig?.productId,
  );
  const variant = product?.variants.nodes.find(
    ({ id }) =>
      id === (core.shopConfig?.variantId ?? core.transformConfig?.variantId),
  );
  if (!product || !variant || !core.transform?.id) {
    throw new UserFacingError("Set up protection before changing the rate.");
  }

  const result = await createAndPublishPricingRule({
    admin,
    shopDomain,
    productId: product.id,
    variantId: variant.id,
    rateBasisPoints,
    publishSnapshot,
  });
  const verified = await readShippingProtectionState(admin, shopDomain);
  if (!verified.ready) throw new UserFacingError("The new rate is live, but setup needs attention. Select Update protection setup.");
  return {
    ...result,
    state: verified,
  };
}

async function runSetup(admin, shopDomain) {
  const core = await loadCore(admin);
  const domain = shopDomain ?? core.shop.myshopifyDomain;
  if (domain !== core.shop.myshopifyDomain) throw new Error("Shopify shop identity does not match the session.");
  const capabilities = observedShopifyCapabilities(core.shop);
  if (!capabilities.checkoutUiSupported || !capabilities.cartTransformUpdateSupported) {
    throw new UserFacingError("This store's Shopify plan doesn't support the checkout protection offer.");
  }
  await ensureInstalledShop(domain, core.shop.id);
  const existingContract = core.shopConfig ?? core.transformConfig;
  let disabledContract = existingContract
    ? { ...existingContract, enabled: false }
    : null;
  let transformId = core.transform?.id ?? null;

  try {
    await disableKnownConfiguration(admin, core, existingContract);

    const existingProduct = await findProduct(
      admin,
      existingContract?.productId,
    );
    const repaired = await repairProduct(
      admin,
      existingProduct,
      existingContract?.variantId,
    );
    disabledContract = existingContract
      ? {
          ...existingContract,
          enabled: false,
          productId: repaired.product.id,
          variantId: repaired.variantId,
        }
      : legacyContractFor(repaired.product.id, repaired.variantId, false);

    await writeJsonMetafield(
      admin,
      core.shop.id,
      SHOP_CONFIG_KEY,
      disabledContract,
    );

    if (!core.onlineStore) {
      throw new UserFacingError("The Online Store sales channel is needed to offer protection. Add it in Shopify, then run setup again.");
    }

    const transform = await ensureTransform(admin, core, disabledContract);
    transformId = transform.id;
    await activateProduct(admin, repaired.product.id, core.onlineStore.id);

    const product = await loadProduct(admin, { id: repaired.product.id });
    if (
      product.status !== "UNLISTED" ||
      product.variantsCount.count !== 1 ||
      !variantIsReady(product.variants.nodes[0]) ||
      !productIsPublished(product, core.onlineStore.id)
    ) {
      throw new Error("Product activation did not pass its health checks.");
    }

    const activeRule = await getActivePricingRule(domain);
    // A rule is tied to one variant; if repair replaced the product or
    // variant, publish a new version at the same rate instead.
    if (activeRule && activeRule.productId === repaired.product.id &&
      activeRule.variantId === repaired.variantId) {
      const enabledContract = pricingContractForRule(
        activeRule,
        repaired.product.id,
        repaired.variantId,
        true,
      );
      await publishSnapshot(admin, enabledContract);
    } else {
      await createAndPublishPricingRule({
        admin,
        shopDomain: domain,
        productId: repaired.product.id,
        variantId: repaired.variantId,
        // loadCore validates the published contract. Preserve its rate when
        // recovering a missing database rule instead of resetting to the default.
        rateBasisPoints:
          activeRule?.rateBasisPoints ??
          existingContract?.rateBasisPoints ??
          DEFAULT_RATE_BASIS_POINTS,
        publishSnapshot,
      });
    }

    const state = await readShippingProtectionState(admin, domain);
    if (!state.ready) {
      throw new UserFacingError("Setup finished, but some checks still fail. See Needs attention.");
    }

    const settings = await enableShopProtection(domain);
    return {
      ...state,
      configuredStrategy: settings.attachmentStrategy,
      configuration: resolveConfiguration(settings, capabilities, state.ready),
    };
  } catch (error) {
    if (disabledContract) {
      const attempts = [
        writeJsonMetafield(
          admin,
          core.shop.id,
          SHOP_CONFIG_KEY,
          disabledContract,
        ),
      ];
      if (transformId) {
        attempts.push(
          writeJsonMetafield(
            admin,
            transformId,
            FUNCTION_CONFIG_KEY,
            disabledContract,
          ),
        );
      }
      await Promise.allSettled(attempts);
    }
    throw error;
  }
}

export const shippingProtectionConstants = {
  productTitle: PRODUCT_TITLE,
  productHandle: PRODUCT_HANDLE,
  functionHandle: FUNCTION_HANDLE,
  rateBasisPoints: DEFAULT_RATE_BASIS_POINTS,
  basis: PRICING_BASIS,
};
