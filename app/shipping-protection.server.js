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
import { ensureInstalledShop } from "./shop.server";
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
  const checks = buildChecks(core, product);
  const activeRule = await getActivePricingRule(domain);
  const healthReady = checks.every(({ ok }) => ok);
  const settings = await getShopConfiguration(domain, {
    legacyReady: !activeRule && Boolean(seed?.enabled) && healthReady,
  });
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

export async function activatePricingRule(
  admin,
  shopDomain,
  rateBasisPoints,
) {
  const core = await loadCore(admin);
  if (shopDomain !== core.shop.myshopifyDomain) throw new Error("Shopify shop identity does not match the session.");
  const capabilities = observedShopifyCapabilities(core.shop);
  if (!capabilities.checkoutUiSupported || !capabilities.cartTransformUpdateSupported) {
    throw new Error("This shop cannot use the checkout block and Cart Transform price update strategy.");
  }
  const current = await readShippingProtectionState(admin, shopDomain);
  if (!current.configuration.protectionEnabled) {
    throw new Error("Run Shipping Protection setup before activating a rule.");
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
    throw new Error("Run Shipping Protection setup before activating a rule.");
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
  if (!verified.ready) throw new Error("Pricing was published, but protection health checks need repair.");
  return {
    ...result,
    state: verified,
  };
}

export async function setupShippingProtection(admin, shopDomain) {
  const core = await loadCore(admin);
  const domain = shopDomain ?? core.shop.myshopifyDomain;
  if (domain !== core.shop.myshopifyDomain) throw new Error("Shopify shop identity does not match the session.");
  const capabilities = observedShopifyCapabilities(core.shop);
  if (!capabilities.checkoutUiSupported || !capabilities.cartTransformUpdateSupported) {
    throw new Error("This shop cannot use the checkout block and Cart Transform price update strategy.");
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
      throw new Error("The Online Store publication is unavailable.");
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
    if (activeRule) {
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
        rateBasisPoints: DEFAULT_RATE_BASIS_POINTS,
        publishSnapshot,
      });
    }

    const state = await readShippingProtectionState(admin, domain);
    if (!state.ready) {
      throw new Error("Setup completed, but one or more health checks failed.");
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
