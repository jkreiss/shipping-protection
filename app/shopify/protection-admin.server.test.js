import { describe, expect, test } from "vitest";
import {
  PRODUCT_TAG, buildChecks, disableKnownConfiguration, ensureTransform, findProduct, repairProduct,
} from "./protection-admin.server";

function productAdmin(product) {
  const operations = [];
  return {
    operations,
    graphql: async (query, { variables } = {}) => {
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      const name = query.match(/\b(?:mutation|query)\s+(\w+)/)?.[1];
      operations.push({ name, variables });
      const data = {
        ShippingProtectionProductByIdentifier: { productByIdentifier: product },
        UpdateShippingProtectionProduct: { productUpdate: { product: { id: product.id }, userErrors: [] } },
        ConfigureShippingProtectionVariant: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } },
      }[name];
      if (!data) throw new Error(`Unexpected operation ${name}`);
      return { json: async () => ({ data }) };
    },
  };
}

const liveProduct = (descriptionHtml) => ({
  id: "gid://shopify/Product/1", title: "Shipping Protection", handle: "shipping-protection",
  status: "UNLISTED", descriptionHtml, variantsCount: { count: 1 },
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/1" }] },
});

describe("repairing the protection product", () => {
  const productUpdates = (admin) => admin.operations
    .filter(({ name }) => name === "UpdateShippingProtectionProduct")
    .map(({ variables }) => variables.product);

  test("never takes a live product off sale", async () => {
    const admin = productAdmin(liveProduct("Merchant wording"));

    await repairProduct(admin, liveProduct("Merchant wording"), "gid://shopify/ProductVariant/1");

    expect(productUpdates(admin)).toHaveLength(1);
    expect(productUpdates(admin)[0]).not.toHaveProperty("status");
  });

  test("keeps a description the merchant wrote", async () => {
    const admin = productAdmin(liveProduct("<p>Merchant wording</p>"));

    await repairProduct(admin, liveProduct("<p>Merchant wording</p>"), "gid://shopify/ProductVariant/1");

    expect(productUpdates(admin)[0]).not.toHaveProperty("descriptionHtml");
  });

  test.each([
    ["", "an empty description"],
    ["<p>Optional coverage for eligible loss, theft, and damage in transit.</p>", "the retired coverage wording"],
    ["Optional shipping protection offered by this store. The fee is based on the items being shipped.", "the retired neutral wording"],
    ["Optional shipping protection offered by this store. Covers packages stolen after delivery.", "the retired theft-only wording"],
  ])("replaces %j (%s) with the current shipping protection wording", async (descriptionHtml) => {
    const admin = productAdmin(liveProduct(descriptionHtml));

    await repairProduct(admin, liveProduct(descriptionHtml), "gid://shopify/ProductVariant/1");

    const { descriptionHtml: written } = productUpdates(admin)[0];
    expect(written).toContain("shipping protection");
    expect(written).toContain("stolen, damaged, and undelivered packages");
    // The product is shipping protection, never insurance or coverage.
    expect(written).not.toMatch(/coverage|insur/i);
  });
});

const disabledConfiguration = { schemaVersion: 2, enabled: false };

function fakeAdmin() {
  const operations = [];
  return {
    operations,
    graphql: async (query, { variables } = {}) => {
      // GraphQL comments run to end of line, as Shopify parses them.
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      const name = query.match(/\bmutation\s+(\w+)/)?.[1];
      operations.push({ name, variables });
      let data;
      if (name === "DeleteShippingProtectionTransform") {
        data = { cartTransformDelete: { deletedId: variables.id, userErrors: [] } };
      } else if (name === "CreateShippingProtectionTransform") {
        data = { cartTransformCreate: { userErrors: [], cartTransform: {
          id: "gid://shopify/CartTransform/new", functionId: "fn", blockOnFailure: variables.blockOnFailure,
        } } };
      } else {
        data = { metafieldsSet: { metafields: [{ id: "m" }], userErrors: [] } };
      }
      return { json: async () => ({ data }) };
    },
  };
}

function core(transform) {
  return { shopifyFunction: { apiVersion: "2026-07" }, transform };
}

describe("turning off the published protection configuration", () => {
  const contract = { schemaVersion: 2, enabled: true, productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1", ruleId: "rule-1", ruleVersion: 3,
    rateBasisPoints: 40, basis: "SHIPPABLE_PRE_DISCOUNT", effectiveAt: "2026-09-01T00:00:00.000Z" };
  const configured = {
    shop: { id: "gid://shopify/Shop/1", configuration: { compareDigest: "shop-digest" } },
    transform: { id: "gid://shopify/CartTransform/1", configuration: { compareDigest: "function-digest" } },
  };

  test("updates checkout and pricing together while preserving the historical rule", async () => {
    const admin = fakeAdmin();
    await disableKnownConfiguration(admin, configured, contract);

    expect(admin.operations).toHaveLength(1);
    const fields = admin.operations[0].variables.metafields;
    expect(fields.map(({ ownerId, key, compareDigest }) => ({ ownerId, key, compareDigest }))).toEqual([
      { ownerId: "gid://shopify/Shop/1", key: "shipping_protection_config", compareDigest: "shop-digest" },
      { ownerId: "gid://shopify/CartTransform/1", key: "function-configuration", compareDigest: "function-digest" },
    ]);
    for (const field of fields) expect(JSON.parse(field.value)).toEqual({ ...contract, enabled: false });
  });

  test("turns off the checkout offer even if the pricing function is missing", async () => {
    const admin = fakeAdmin();
    await disableKnownConfiguration(admin, { ...configured, transform: null }, contract);
    expect(admin.operations[0].variables.metafields).toHaveLength(1);
    expect(JSON.parse(admin.operations[0].variables.metafields[0].value).enabled).toBe(false);
  });

  test("surfaces Shopify conflicts instead of reporting a successful disable", async () => {
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      metafieldsSet: { userErrors: [{ field: ["metafields"], message: "Configuration changed", code: "INVALID_COMPARE_DIGEST" }] },
    } }) }) };
    await expect(disableKnownConfiguration(admin, configured, contract)).rejects.toThrow("Configuration changed");
  });
});

describe("Cart Transform failure behavior", () => {
  test("creates a transform that never blocks checkout", async () => {
    const admin = fakeAdmin();

    const transform = await ensureTransform(admin, core(null), disabledConfiguration);

    const create = admin.operations.find(({ name }) => name === "CreateShippingProtectionTransform");
    expect(create.variables.blockOnFailure).toBe(false);
    expect(transform.blockOnFailure).toBe(false);
  });

  test("replaces a transform that blocks checkout on failure", async () => {
    const admin = fakeAdmin();

    await ensureTransform(admin, core({ id: "gid://shopify/CartTransform/old", blockOnFailure: true }), disabledConfiguration);

    expect(admin.operations.map(({ name }) => name)).toEqual([
      "DeleteShippingProtectionTransform", "CreateShippingProtectionTransform",
    ]);
    expect(admin.operations[0].variables.id).toBe("gid://shopify/CartTransform/old");
  });

  test("keeps a non-blocking transform and only rewrites its configuration", async () => {
    const admin = fakeAdmin();

    await ensureTransform(admin, core({ id: "gid://shopify/CartTransform/kept", blockOnFailure: false }), disabledConfiguration);

    expect(admin.operations.map(({ name }) => name)).not.toContain("DeleteShippingProtectionTransform");
    expect(admin.operations.map(({ name }) => name)).not.toContain("CreateShippingProtectionTransform");
  });

  test("leaves a live transform's configuration alone when asked not to overwrite it", async () => {
    const admin = fakeAdmin();

    await ensureTransform(admin, core({ id: "gid://shopify/CartTransform/kept", blockOnFailure: false }),
      { schemaVersion: 2, enabled: true }, { overwrite: false });

    expect(admin.operations).toEqual([]);
  });

  test.each([
    [{ id: "t", blockOnFailure: false }, true],
    [{ id: "t", blockOnFailure: true }, false],
    [null, false],
  ])("transform check for %o passes: %s", (transform, ok) => {
    const check = buildChecks(core(transform), null).find(({ id }) => id === "transform");
    expect(check.label).toBe("Cart Transform is active");
    expect(check.ok).toBe(ok);
  });
});

describe("finding the protection product", () => {
  const merchantProduct = {
    ...liveProduct("Merchant wording"), id: "gid://shopify/Product/99", title: "Gift wrap", tags: ["gifts"],
  };
  const ours = (id = "gid://shopify/Product/1") => ({ ...liveProduct("x"), id, tags: [PRODUCT_TAG] });

  // Resolves productByIdentifier from a map keyed by "id:<gid>" or "handle:<handle>".
  function lookupAdmin(products) {
    const operations = [];
    return {
      operations,
      graphql: async (query, { variables } = {}) => {
        const name = query.match(/\b(?:mutation|query)\s+(\w+)/)?.[1];
        operations.push({ name, variables });
        const { id, handle } = variables?.identifier ?? {};
        const data = {
          ShippingProtectionProductByIdentifier: {
            productByIdentifier: products[id ? `id:${id}` : `handle:${handle}`] ?? null,
          },
          CreateShippingProtectionProduct: {
            productCreate: { product: { id: "gid://shopify/Product/2" }, userErrors: [] },
          },
        }[name];
        if (!data) throw new Error(`Unexpected operation ${name}`);
        return { json: async () => ({ data }) };
      },
    };
  }

  test("does not adopt a product at the handle that the app did not create", async () => {
    const admin = lookupAdmin({ "handle:shipping-protection": { ...merchantProduct, title: "Shipping Protection" } });
    expect(await findProduct(admin, null)).toBeNull();
  });

  test("adopts a product at the handle that carries the app tag", async () => {
    const admin = lookupAdmin({ "handle:shipping-protection": ours() });
    expect(await findProduct(admin, null)).toMatchObject({ id: "gid://shopify/Product/1" });
  });

  test("prefers the configured product, then the recorded one, over the handle", async () => {
    const admin = lookupAdmin({
      "id:gid://shopify/Product/5": ours("gid://shopify/Product/5"),
      "id:gid://shopify/Product/6": ours("gid://shopify/Product/6"),
      "handle:shipping-protection": ours("gid://shopify/Product/7"),
    });
    expect(await findProduct(admin, "gid://shopify/Product/5", {
      recordedProductId: "gid://shopify/Product/6",
    })).toMatchObject({ id: "gid://shopify/Product/5" });
    expect(await findProduct(admin, "gid://shopify/Product/404", {
      recordedProductId: "gid://shopify/Product/6",
    })).toMatchObject({ id: "gid://shopify/Product/6" });
  });

  test("setup creates a tagged product and never edits the merchant's product", async () => {
    const created = { ...ours("gid://shopify/Product/2"), handle: "shipping-protection-1" };
    const admin = lookupAdmin({
      "handle:shipping-protection": { ...merchantProduct, title: "Shipping Protection" },
      "id:gid://shopify/Product/2": created,
    });
    admin.graphql = ((inner) => async (query, options) => {
      const name = query.match(/\b(?:mutation|query)\s+(\w+)/)?.[1];
      if (name === "UpdateShippingProtectionProduct") {
        admin.operations.push({ name, variables: options.variables });
        return { json: async () => ({ data: { productUpdate: { product: { id: options.variables.product.id }, userErrors: [] } } }) };
      }
      if (name === "ConfigureShippingProtectionVariant") {
        admin.operations.push({ name, variables: options.variables });
        return { json: async () => ({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } }) };
      }
      return inner(query, options);
    })(admin.graphql);

    const found = await findProduct(admin, null);
    await repairProduct(admin, found, undefined);

    const create = admin.operations.find(({ name }) => name === "CreateShippingProtectionProduct");
    expect(create.variables.product.tags).toEqual([PRODUCT_TAG]);
    const touched = admin.operations
      .filter(({ name }) => name === "UpdateShippingProtectionProduct")
      .map(({ variables }) => variables.product.id);
    expect(touched).not.toContain(merchantProduct.id);
    expect(admin.operations.some(({ variables }) => variables?.productId === merchantProduct.id)).toBe(false);
  });

  test("repair keeps the merchant's tags and does not force the handle", async () => {
    const product = { ...liveProduct("Merchant wording"), handle: "shipping-protection-1", tags: ["vip"] };
    const admin = productAdmin(product);
    await repairProduct(admin, product, "gid://shopify/ProductVariant/1");
    const update = admin.operations.find(({ name }) => name === "UpdateShippingProtectionProduct").variables.product;
    expect(update.tags).toEqual(["vip", PRODUCT_TAG]);
    expect(update).not.toHaveProperty("handle");
  });
});

describe("product readiness check", () => {
  const product = (overrides) => ({
    ...liveProduct("x"), tags: [], variants: { nodes: [] }, resourcePublicationsV2: { nodes: [] }, ...overrides,
  });
  const productCheck = (core, candidate) => buildChecks(core, candidate).find(({ id }) => id === "product").ok;
  const core = (productId) => ({ shopConfig: { productId }, transformConfig: null, shopifyFunction: null });

  test("accepts the configured product even without the tag or handle", () => {
    expect(productCheck(core("gid://shopify/Product/1"), product({ handle: "shipping-protection-1" }))).toBe(true);
  });

  test("accepts a tagged product", () => {
    expect(productCheck(core(null), product({ tags: [PRODUCT_TAG] }))).toBe(true);
  });

  test("rejects an unrelated product that happens to have the title", () => {
    expect(productCheck(core("gid://shopify/Product/9"), product({ tags: ["gifts"] }))).toBe(false);
  });
});
