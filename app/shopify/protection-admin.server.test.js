import { describe, expect, test } from "vitest";
import { buildChecks, ensureTransform } from "./protection-admin.server";

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
