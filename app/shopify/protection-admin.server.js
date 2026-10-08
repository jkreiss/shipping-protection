import { parsePricingContract } from "../pricing-contract";
import { adminGraphql as graphql, assertUserErrors } from "./admin-graphql.server";

const PRODUCT_TITLE = "Shipping Protection";
const PRODUCT_HANDLE = "shipping-protection";
// Marks the product this app created, so setup never adopts, edits, or deletes
// variants on a merchant's own product that merely shares the handle.
export const PRODUCT_TAG = "yasas-shipping-protection";
const FUNCTION_HANDLE = "shipping-protection-transform";
const SHOP_CONFIG_KEY = "shipping_protection_config";
const FUNCTION_CONFIG_KEY = "function-configuration";
const CONFIG_NAMESPACE = "$app";
const API_VERSION = "2026-07";
// Customer-visible, and must match the checkout copy. Before changing it, follow
// "Changing customer-facing copy" in docs/agents/legal-product.md.
const PRODUCT_DESCRIPTION =
  "Optional shipping protection offered by this store. Covers stolen, damaged, and undelivered packages.";
// Descriptions earlier versions wrote. Setup replaces these, but keeps a
// description the merchant wrote themselves.
const RETIRED_DESCRIPTIONS = new Set([
  "Optional coverage for eligible loss, theft, and damage in transit.",
  "Optional shipping protection offered by this store. The fee is based on the items being shipped.",
  "Optional shipping protection offered by this store. Covers packages stolen after delivery.",
]);

const PRODUCT_FIELDS = `#graphql
  fragment ShippingProtectionProduct on Product {
    id
    title
    handle
    tags
    status
    descriptionHtml
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

export function sameContract(left, right, enabled) {
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

export async function loadCore(admin) {
  const data = await graphql(
    admin,
    `
      #graphql
      query ShippingProtectionCore {
        shop {
          id
          name
          myshopifyDomain
          plan { shopifyPlus }
          features { cartTransform { eligibleOperations { updateOperation } } }
          configuration: metafield(
            namespace: "$app"
            key: "shipping_protection_config"
          ) {
            jsonValue
            compareDigest
          }
          checkoutOffer: metafield(namespace: "$app", key: "shipping_protection_offer") {
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

export async function loadProduct(admin, identifier) {
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

// Looks for the configured product, then the one the active pricing rule
// recorded, then the handle, which only counts when the product carries our tag.
export async function findProduct(
  admin,
  configuredProductId,
  { recordedProductId } = {},
) {
  for (const id of new Set([configuredProductId, recordedProductId])) {
    if (!id) continue;
    const product = await loadProduct(admin, { id });
    if (product) return product;
  }

  const byHandle = await loadProduct(admin, { handle: PRODUCT_HANDLE });
  return byHandle?.tags?.includes(PRODUCT_TAG) ? byHandle : null;
}

export function productIsPublished(product, publicationId) {
  return Boolean(
    publicationId &&
    product?.resourcePublicationsV2.nodes.some(
      (resource) =>
        resource.isPublished && resource.publication.id === publicationId,
    ),
  );
}

export function variantIsReady(variant) {
  return Boolean(
    variant &&
    Number(variant.price) === 0 &&
    variant.taxable === true &&
    variant.inventoryPolicy === "DENY" &&
    variant.inventoryItem.tracked === false &&
    variant.inventoryItem.requiresShipping === false,
  );
}

export function buildChecks(core, product) {
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
        (product.id === source?.productId || product.tags?.includes(PRODUCT_TAG)),
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
      label: "Cart Transform is active",
      ok: core.transform?.blockOnFailure === false,
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

export async function writeJsonMetafield(
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

export async function disableKnownConfiguration(admin, core, contract) {
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
        tags: [PRODUCT_TAG],
        descriptionHtml: PRODUCT_DESCRIPTION,
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

function descriptionNeedsReplacing(descriptionHtml) {
  const text = (descriptionHtml ?? "").replace(/<[^>]*>/g, "").trim();
  return text === "" || RETIRED_DESCRIPTIONS.has(text);
}

// Restores the fields setup relies on without touching the product's status,
// so repairing a live product never takes it off sale. productUpdate replaces
// the whole tag list, so the merchant's tags are kept. The handle is left
// alone: Shopify suffixes it when another product already holds the handle.
function normalizeProduct(admin, product) {
  const tags = product.tags ?? [];
  return updateProduct(admin, {
    id: product.id,
    title: PRODUCT_TITLE,
    tags: tags.includes(PRODUCT_TAG) ? tags : [...tags, PRODUCT_TAG],
    ...(descriptionNeedsReplacing(product.descriptionHtml)
      ? { descriptionHtml: PRODUCT_DESCRIPTION }
      : {}),
    productType: "Shipping Protection",
    requiresSellingPlan: false,
  });
}

async function updateProduct(admin, product) {
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
    { product },
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

export async function repairProduct(admin, existingProduct, preferredVariantId) {
  const product = existingProduct ?? (await createProduct(admin));
  if (!product) throw new Error("Could not create Shipping Protection.");

  await normalizeProduct(admin, product);

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
      // Never block checkout: if the Function fails, the protection line keeps
      // the variant's own price instead.
      blockOnFailure: false,
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

export function assertFunctionDeployed(core) {
  if (core.shopifyFunction?.apiVersion !== API_VERSION) {
    throw new Error(
      `Deploy the ${FUNCTION_HANDLE} Function on API ${API_VERSION} before running setup.`,
    );
  }
}

// An existing transform keeps its configuration unless `overwrite` is set,
// so a live store keeps charging its current price while setup repairs it.
export async function ensureTransform(
  admin,
  core,
  configuration,
  { overwrite = true } = {},
) {
  assertFunctionDeployed(core);

  let transform = core.transform;
  // Shopify can't update blockOnFailure in place, so replace a blocking one.
  if (transform && transform.blockOnFailure !== false) {
    await deleteTransform(admin, transform.id);
    transform = null;
  }

  if (!transform) {
    transform = await createTransform(admin, configuration);
  } else if (overwrite) {
    await writeJsonMetafield(
      admin,
      transform.id,
      FUNCTION_CONFIG_KEY,
      configuration,
    );
  }

  return transform;
}

export async function activateProduct(admin, productId, publicationId) {
  await updateProduct(admin, { id: productId, status: "UNLISTED" });

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

export async function publishSnapshot(admin, snapshot) {
  const core = await loadCore(admin);
  await writeConfigurationSnapshot(admin, core, snapshot);
}

export const protectionAdminConstants = {
  productTitle: PRODUCT_TITLE,
  productHandle: PRODUCT_HANDLE,
  functionHandle: FUNCTION_HANDLE,
  apiVersion: API_VERSION,
  shopConfigKey: SHOP_CONFIG_KEY,
  functionConfigKey: FUNCTION_CONFIG_KEY,
};
