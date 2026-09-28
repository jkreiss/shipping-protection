import {
  DEFAULT_RATE_BASIS_POINTS,
  PRICING_BASIS,
  formatBasisPoints,
  parsePricingContract,
  pricingContractForRule,
} from "./pricing-contract";
import {
  createAndPublishPricingRule,
  getActivePricingRule,
  reconcilePublishedPricingRule,
} from "./pricing-rule.server";
import { ensureInstalledShop } from "./shop.server";

const PRODUCT_TITLE = "Shipping Protection";
const PRODUCT_HANDLE = "shipping-protection";
const FUNCTION_HANDLE = "shipping-protection-transform";
const SHOP_CONFIG_KEY = "shipping_protection_config";
const FUNCTION_CONFIG_KEY = "function-configuration";
const CONFIG_NAMESPACE = "$app";
const API_VERSION = "2026-07";

const PRODUCT_FIELDS = `#graphql
  fragment ShippingProtectionProduct on Product {
    id
    title
    handle
    status
    variantsCount {
      count
    }
    onlineStoreUrl
    variants(first: 250) {
      nodes {
        id
        price
        taxable
        inventoryPolicy
        inventoryItem {
          tracked
          requiresShipping
        }
      }
    }
    resourcePublicationsV2(first: 50, onlyPublished: true) {
      nodes {
        isPublished
        publication {
          id
        }
      }
    }
  }
`;

async function graphql(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join("; "));
  }

  return payload.data;
}

function assertUserErrors(payload, operation) {
  const errors = payload?.userErrors ?? [];
  if (errors.length > 0) {
    const message = errors
      .map(
        ({ field, message: errorMessage }) =>
          `${field?.join(".") || operation}: ${errorMessage}`,
      )
      .join("; ");
    throw new Error(message);
  }
}

function legacyContractFor(productId, variantId, enabled) {
  return {
    schemaVersion: 1,
    enabled,
    productId,
    variantId,
    rateBasisPoints: DEFAULT_RATE_BASIS_POINTS,
    basis: PRICING_BASIS,
  };
}

function sameContract(left, right, enabled) {
  return Boolean(
    left &&
    right &&
    left.productId === right.productId &&
    left.variantId === right.variantId &&
    left.enabled === enabled &&
    right.enabled === enabled &&
    left.rateBasisPoints === right.rateBasisPoints &&
    left.basis === right.basis &&
    left.schemaVersion === right.schemaVersion &&
    (left.schemaVersion === 1 ||
      (left.ruleId === right.ruleId &&
        left.ruleVersion === right.ruleVersion &&
        left.effectiveAt === right.effectiveAt)),
  );
}

async function loadCore(admin) {
  const data = await graphql(
    admin,
    `
      #graphql
      query ShippingProtectionCore {
        shop {
          id
          name
          myshopifyDomain
          configuration: metafield(
            namespace: "$app"
            key: "shipping_protection_config"
          ) {
            jsonValue
            compareDigest
          }
        }
        publications(first: 50) {
          nodes {
            id
            name
            app {
              title
            }
          }
        }
        shopifyFunctions(first: 50, apiType: "cart_transform") {
          nodes {
            id
            handle
            title
            apiType
            apiVersion
          }
        }
        cartTransforms(first: 50) {
          nodes {
            id
            functionId
            blockOnFailure
            configuration: metafield(
              namespace: "$app"
              key: "function-configuration"
            ) {
              jsonValue
              compareDigest
            }
          }
        }
      }
    `,
  );

  const shopConfig = parsePricingContract(
    data.shop.configuration?.jsonValue,
  );
  const shopifyFunction = data.shopifyFunctions.nodes.find(
    ({ handle }) => handle === FUNCTION_HANDLE,
  );
  const transformsForFunction = shopifyFunction
    ? data.cartTransforms.nodes.filter(
        ({ functionId }) => functionId === shopifyFunction.id,
      )
    : [];
  const transform = transformsForFunction[0] ?? null;
  const onlineStore = data.publications.nodes.find(
    ({ name, app }) => name === "Online Store" || app?.title === "Online Store",
  );

  return {
    shop: data.shop,
    shopConfig,
    shopifyFunction: shopifyFunction ?? null,
    transform,
    transformsForFunction,
    transformConfig: parsePricingContract(
      transform?.configuration?.jsonValue,
    ),
    onlineStore: onlineStore ?? null,
  };
}

async function loadProduct(admin, identifier) {
  if (!identifier) return null;

  const data = await graphql(
    admin,
    `
      #graphql
      ${PRODUCT_FIELDS}
      query ShippingProtectionProductByIdentifier(
        $identifier: ProductIdentifierInput!
      ) {
        productByIdentifier(identifier: $identifier) {
          ...ShippingProtectionProduct
        }
      }
    `,
    { identifier },
  );

  return data.productByIdentifier;
}

async function findProduct(admin, configuredProductId) {
  if (configuredProductId) {
    const configured = await loadProduct(admin, { id: configuredProductId });
    if (configured) return configured;
  }

  return loadProduct(admin, { handle: PRODUCT_HANDLE });
}

function productIsPublished(product, publicationId) {
  return Boolean(
    publicationId &&
    product?.resourcePublicationsV2.nodes.some(
      (resource) =>
        resource.isPublished && resource.publication.id === publicationId,
    ),
  );
}

function variantIsReady(variant) {
  return Boolean(
    variant &&
    Number(variant.price) === 0 &&
    variant.taxable === true &&
    variant.inventoryPolicy === "DENY" &&
    variant.inventoryItem.tracked === false &&
    variant.inventoryItem.requiresShipping === false,
  );
}

function buildChecks(core, product) {
  const variant = product?.variants.nodes.find(
    ({ id }) => id === core.shopConfig?.variantId,
  );
  const source = core.shopConfig ?? core.transformConfig;
  const expected =
    source && product && variant
      ? {
          ...source,
          enabled: true,
          productId: product.id,
          variantId: variant.id,
        }
      : source;

  return [
    {
      id: "function",
      label: "2026-07 Cart Transform Function is deployed",
      ok: core.shopifyFunction?.apiVersion === API_VERSION,
    },
    {
      id: "product",
      label: "Shipping Protection product exists",
      ok: Boolean(
        product &&
        product.title === PRODUCT_TITLE &&
        product.handle === PRODUCT_HANDLE,
      ),
    },
    {
      id: "variant",
      label: "One $0.00, taxable, non-shipping variant is configured",
      ok: Boolean(
        product?.variantsCount.count === 1 && variantIsReady(variant),
      ),
    },
    {
      id: "unlisted",
      label: "Product is active and unlisted",
      ok: product?.status === "UNLISTED",
    },
    {
      id: "publication",
      label: "Product is published to Online Store",
      ok: productIsPublished(product, core.onlineStore?.id),
    },
    {
      id: "transform",
      label: "Blocking Cart Transform is active",
      ok: Boolean(core.transform?.blockOnFailure),
    },
    {
      id: "transformConfig",
      label: "Cart Transform pricing configuration is enabled",
      ok: sameContract(core.transformConfig, expected, true),
    },
    {
      id: "checkoutConfig",
      label: "Checkout configuration is enabled",
      ok: sameContract(core.shopConfig, expected, true),
    },
  ];
}

export async function readShippingProtectionState(admin, shopDomain) {
  const core = await loadCore(admin);
  const domain = shopDomain ?? core.shop.myshopifyDomain;
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

  return {
    shopName: core.shop.name,
    ready: checks.every(({ ok }) => ok),
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

async function writeJsonMetafield(
  admin,
  ownerId,
  key,
  value,
  compareDigest = undefined,
) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation SetShippingProtectionConfiguration(
        $metafields: [MetafieldsSetInput!]!
      ) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId,
          key,
          type: "json",
          value: JSON.stringify(value),
          ...(compareDigest !== undefined ? { compareDigest } : {}),
        },
      ],
    },
  );

  assertUserErrors(data.metafieldsSet, "metafieldsSet");
}

async function writeConfigurationSnapshot(admin, core, snapshot) {
  if (!core.transform?.id) {
    throw new Error("The Shipping Protection Cart Transform is unavailable.");
  }

  const data = await graphql(
    admin,
    `
      #graphql
      mutation PublishShippingProtectionConfiguration(
        $metafields: [MetafieldsSetInput!]!
      ) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            compareDigest
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: core.shop.id,
          key: SHOP_CONFIG_KEY,
          type: "json",
          value: JSON.stringify(snapshot),
          compareDigest: core.shop.configuration?.compareDigest ?? null,
        },
        {
          ownerId: core.transform.id,
          key: FUNCTION_CONFIG_KEY,
          type: "json",
          value: JSON.stringify(snapshot),
          compareDigest: core.transform.configuration?.compareDigest ?? null,
        },
      ],
    },
  );

  assertUserErrors(data.metafieldsSet, "metafieldsSet");
}

async function disableKnownConfiguration(admin, core, contract) {
  if (!contract) return;

  const disabled = { ...contract, enabled: false };
  if (core.transform?.id) {
    await writeConfigurationSnapshot(admin, core, disabled);
  } else {
    await writeJsonMetafield(
      admin,
      core.shop.id,
      SHOP_CONFIG_KEY,
      disabled,
      core.shop.configuration?.compareDigest ?? null,
    );
  }
}

async function createProduct(admin) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation CreateShippingProtectionProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      product: {
        title: PRODUCT_TITLE,
        handle: PRODUCT_HANDLE,
        descriptionHtml:
          "Optional coverage for eligible loss, theft, and damage in transit.",
        productType: "Shipping Protection",
        requiresSellingPlan: false,
        status: "DRAFT",
      },
    },
  );

  assertUserErrors(data.productCreate, "productCreate");
  if (!data.productCreate.product) {
    throw new Error("Shopify did not return the created product.");
  }

  return loadProduct(admin, { id: data.productCreate.product.id });
}

async function setProductStatus(admin, productId, status) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation UpdateShippingProtectionProduct($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      product: {
        id: productId,
        title: PRODUCT_TITLE,
        handle: PRODUCT_HANDLE,
        descriptionHtml:
          "Optional coverage for eligible loss, theft, and damage in transit.",
        productType: "Shipping Protection",
        requiresSellingPlan: false,
        status,
      },
    },
  );

  assertUserErrors(data.productUpdate, "productUpdate");
}

async function updateVariant(admin, productId, variantId) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation ConfigureShippingProtectionVariant(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: [
        {
          id: variantId,
          price: "0.00",
          taxable: true,
          inventoryPolicy: "DENY",
          inventoryItem: {
            tracked: false,
            requiresShipping: false,
          },
        },
      ],
    },
  );

  assertUserErrors(data.productVariantsBulkUpdate, "productVariantsBulkUpdate");
}

async function deleteVariants(admin, productId, variantIds) {
  if (variantIds.length === 0) return;

  const data = await graphql(
    admin,
    `
      #graphql
      mutation DeleteExtraShippingProtectionVariants(
        $productId: ID!
        $variantIds: [ID!]!
      ) {
        productVariantsBulkDelete(
          productId: $productId
          variantsIds: $variantIds
        ) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { productId, variantIds },
  );

  assertUserErrors(data.productVariantsBulkDelete, "productVariantsBulkDelete");
}

async function repairProduct(admin, existingProduct, preferredVariantId) {
  const product = existingProduct ?? (await createProduct(admin));
  if (!product) throw new Error("Could not create Shipping Protection.");

  await setProductStatus(admin, product.id, "DRAFT");

  let current = await loadProduct(admin, { id: product.id });
  const chosen =
    current.variants.nodes.find(({ id }) => id === preferredVariantId) ??
    current.variants.nodes[0];
  if (!chosen) throw new Error("Shipping Protection has no product variant.");

  await updateVariant(admin, current.id, chosen.id);

  for (let pass = 0; pass < 10 && current.variantsCount.count > 1; pass += 1) {
    const extras = current.variants.nodes
      .filter(({ id }) => id !== chosen.id)
      .map(({ id }) => id);
    if (extras.length === 0) {
      throw new Error(
        "Could not enumerate extra Shipping Protection variants.",
      );
    }
    await deleteVariants(admin, current.id, extras);
    current = await loadProduct(admin, { id: current.id });
  }

  if (current.variantsCount.count !== 1) {
    throw new Error("Could not reduce Shipping Protection to one variant.");
  }

  return { product: current, variantId: chosen.id };
}

async function deleteTransform(admin, transformId) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation DeleteShippingProtectionTransform($id: ID!) {
        cartTransformDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `,
    { id: transformId },
  );

  assertUserErrors(data.cartTransformDelete, "cartTransformDelete");
}

async function createTransform(admin, configuration) {
  const data = await graphql(
    admin,
    `
      #graphql
      mutation CreateShippingProtectionTransform(
        $functionHandle: String
        $blockOnFailure: Boolean
        $metafields: [MetafieldInput!]
      ) {
        cartTransformCreate(
          functionHandle: $functionHandle
          blockOnFailure: $blockOnFailure
          metafields: $metafields
        ) {
          cartTransform {
            id
            functionId
            blockOnFailure
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      functionHandle: FUNCTION_HANDLE,
      blockOnFailure: true,
      metafields: [
        {
          namespace: CONFIG_NAMESPACE,
          key: FUNCTION_CONFIG_KEY,
          type: "json",
          value: JSON.stringify(configuration),
        },
      ],
    },
  );

  assertUserErrors(data.cartTransformCreate, "cartTransformCreate");
  if (!data.cartTransformCreate.cartTransform) {
    throw new Error("Shopify did not return the created Cart Transform.");
  }

  return data.cartTransformCreate.cartTransform;
}

async function ensureTransform(admin, core, disabledConfiguration) {
  if (core.shopifyFunction?.apiVersion !== API_VERSION) {
    throw new Error(
      `Deploy the ${FUNCTION_HANDLE} Function on API ${API_VERSION} before running setup.`,
    );
  }

  let transform = core.transform;
  if (transform && !transform.blockOnFailure) {
    await deleteTransform(admin, transform.id);
    transform = null;
  }

  if (!transform) {
    transform = await createTransform(admin, disabledConfiguration);
  } else {
    await writeJsonMetafield(
      admin,
      transform.id,
      FUNCTION_CONFIG_KEY,
      disabledConfiguration,
    );
  }

  return transform;
}

async function activateProduct(admin, productId, publicationId) {
  await setProductStatus(admin, productId, "UNLISTED");

  const data = await graphql(
    admin,
    `
      #graphql
      mutation PublishShippingProtection(
        $id: ID!
        $input: [PublicationInput!]!
        $publicationId: ID!
      ) {
        publishablePublish(id: $id, input: $input) {
          publishable {
            ... on Product {
              id
              publishedOnPublication(publicationId: $publicationId)
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: productId,
      input: [{ publicationId }],
      publicationId,
    },
  );

  assertUserErrors(data.publishablePublish, "publishablePublish");
  if (!data.publishablePublish.publishable?.publishedOnPublication) {
    throw new Error("Shipping Protection was not published to Online Store.");
  }
}

async function publishSnapshot(admin, snapshot) {
  const core = await loadCore(admin);
  await writeConfigurationSnapshot(admin, core, snapshot);
}

export async function activatePricingRule(
  admin,
  shopDomain,
  rateBasisPoints,
) {
  const core = await loadCore(admin);
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
  return {
    ...result,
    state: await readShippingProtectionState(admin, shopDomain),
  };
}

export async function setupShippingProtection(admin, shopDomain) {
  const core = await loadCore(admin);
  const domain = shopDomain ?? core.shop.myshopifyDomain;
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

    return state;
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
