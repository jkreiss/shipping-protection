import { describe, expect, test } from "vitest";
import {
  updateCheckoutOffer,
  checkoutOfferForSettings,
} from "./checkout-offer.server.js";

function fixture(settings = {}) {
  const configuration = {
    shopId: "one",
    protectionCopyEditable: true,
    protectionCheckboxLabel: null,
    protectionSupportingText: null,
    ...settings,
  };
  const shop = {
    id: "one",
    installationState: "INSTALLED",
    shopDomain: "one.myshopify.com",
    installationGeneration: 0,
    settingsLockedUntil: null,
    configuration,
  };
  const database = {
    shop: {
      findUnique: async ({ where }) =>
        where.shopDomain === "one.myshopify.com" ? shop : null,
      updateMany: async ({ where, data }) => {
        if (
          where.OR &&
          shop.settingsLockedUntil > where.OR[1].settingsLockedUntil.lte
        )
          return { count: 0 };
        Object.assign(shop, data);
        return { count: 1 };
      },
    },
    shopConfiguration: {
      update: async ({ where, data }) => {
        if (where.shopId !== "one") throw new Error("Wrong tenant");
        Object.assign(configuration, data);
        return configuration;
      },
    },
  };
  database.$transaction = async (run) => run(database);
  const writes = [];
  const liveShop = {
    id: "gid://shopify/Shop/1",
    myshopifyDomain: "one.myshopify.com",
    checkoutOffer: null,
  };
  const admin = {
    graphql: async (query, { variables }) => {
      if (!query.replace(/#[^\n]*/g, "").trim())
        throw new Error("Empty GraphQL");
      if (query.includes("query ShippingProtectionCore"))
        return {
          json: async () => ({
            data: {
              shop: liveShop,
              publications: { nodes: [] },
              shopifyFunctions: { nodes: [] },
              cartTransforms: { nodes: [] },
            },
          }),
        };
      if (!query.includes("mutation SetShippingProtectionConfiguration"))
        throw new Error("Unexpected operation");
      if (admin.failPublication)
        throw new Error("Shopify rejected publication");
      writes.push(...variables.metafields);
      liveShop.checkoutOffer = {
        jsonValue: JSON.parse(variables.metafields[0].value),
        compareDigest: "new-digest",
      };
      return {
        json: async () => ({
          data: { metafieldsSet: { userErrors: [], metafields: [] } },
        }),
      };
    },
    failPublication: false,
  };
  return { database, configuration, shop, admin, writes, liveShop };
}

describe("merchant checkout offer", () => {
  test("validates preserved local copy before publishing a merged update", async () => {
    const f = fixture({ protectionSupportingText: "Invalid\u202Ecopy" });
    await expect(updateCheckoutOffer(f.admin, "one.myshopify.com", {
      checkboxLabel: "Choose shipping protection",
    }, { database: f.database })).rejects.toThrow("plain text");
    expect(f.writes).toHaveLength(0);
    expect(f.configuration.protectionCheckboxLabel).toBeNull();
    expect(f.shop.settingsLockedUntil).toBeNull();
  });
  test("publishes copy while preserving other published copy and permissions", async () => {
    const f = fixture();
    f.liveShop.checkoutOffer = {
      jsonValue: {
        schemaVersion: 1,
        checkboxLabel: null,
        supportingText: "Existing after-delivery theft text.",
      },
      compareDigest: "existing-digest",
    };
    await updateCheckoutOffer(
      f.admin,
      "one.myshopify.com",
      {
        checkboxLabel: "Choose shipping protection",
      },
      { database: f.database },
    );
    expect(JSON.parse(f.writes[0].value)).toEqual({
      schemaVersion: 1,
      checkboxLabel: "Choose shipping protection",
      supportingText: "Existing after-delivery theft text.",
    });
    expect(f.configuration).toMatchObject({
      protectionCopyEditable: true,
      protectionCheckboxLabel: "Choose shipping protection",
    });
    expect(f.shop.settingsLockedUntil).toBeNull();
  });

  test.each([
    [
      { protectionCopyEditable: false },
      {
        checkboxLabel: "Choose shipping protection",
        supportingText: "After-delivery theft.",
      },
    ],
  ])(
    "rejects a locked editor server-side before publication",
    async (settings, changes) => {
      const f = fixture(settings);
      await expect(
        updateCheckoutOffer(f.admin, "one.myshopify.com", changes, {
          database: f.database,
        }),
      ).rejects.toThrow("managed");
      expect(f.writes).toHaveLength(0);
    },
  );

  test.each([
    { checkboxLabel: "Protect my parcel", supportingText: "Your choice." },
    { checkboxLabel: "Insurance", supportingText: "Lost or damaged packages." },
    {
      checkboxLabel: "Add protection < $5",
      supportingText: "First line.\nSecond line with <b>literal text</b>.",
    },
  ])("publishes unrestricted wording as plain text: %j", async (changes) => {
    const f = fixture();
    await updateCheckoutOffer(f.admin, "one.myshopify.com", changes, {
      database: f.database,
    });
    expect(JSON.parse(f.writes[0].value)).toEqual({
      schemaVersion: 1,
      ...changes,
    });
    expect(
      checkoutOfferForSettings(
        f.configuration,
        f.liveShop.checkoutOffer.jsonValue,
      ),
    ).toEqual({
      schemaVersion: 1,
      ...changes,
    });
  });

  test.each([
    { protectionCopyEditable: true },
    { checkboxLabel: "x".repeat(121), supportingText: "Text" },
    { supportingText: "x".repeat(501) },
    {
      checkboxLabel: "Shipping protection",
      supportingText: "Text\u0000with a control character",
    },
  ])(
    "validates untrusted settings without changing published values: %j",
    async (changes) => {
      const f = fixture();
      await expect(
        updateCheckoutOffer(f.admin, "one.myshopify.com", changes, {
          database: f.database,
        }),
      ).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    },
  );

  test("preserves existing settings when Shopify rejects the write", async () => {
    const f = fixture();
    f.admin.failPublication = true;
    await expect(
      updateCheckoutOffer(
        f.admin,
        "one.myshopify.com",
        { checkboxLabel: "Choose shipping protection" },
        { database: f.database },
      ),
    ).rejects.toThrow("rejected");
    expect(f.shop.settingsLockedUntil).toBeNull();
  });

  test("rejects another shop and refuses concurrent settings changes", async () => {
    const f = fixture();
    f.liveShop.myshopifyDomain = "two.myshopify.com";
    await expect(
      updateCheckoutOffer(
        f.admin,
        "one.myshopify.com",
        { checkboxLabel: "Choose shipping protection" },
        { database: f.database },
      ),
    ).rejects.toThrow("identity");
    f.liveShop.myshopifyDomain = "one.myshopify.com";
    f.shop.settingsLockedUntil = new Date(Date.now() + 60_000);
    await expect(
      updateCheckoutOffer(
        f.admin,
        "one.myshopify.com",
        { checkboxLabel: "Choose shipping protection" },
        { database: f.database },
      ),
    ).rejects.toThrow("Another settings change");
    expect(f.writes).toHaveLength(0);
  });

  test("recovers a Shopify publication whose local save failed, then resets copy to defaults", async () => {
    const f = fixture();
    const save = f.database.shopConfiguration.update;
    f.database.shopConfiguration.update = async () => {
      throw new Error("Local save interrupted");
    };
    await expect(
      updateCheckoutOffer(
        f.admin,
        "one.myshopify.com",
        {
          checkboxLabel: "Choose shipping protection",
          supportingText: "After-delivery theft.",
        },
        { database: f.database },
      ),
    ).rejects.toThrow("interrupted");
    expect(f.shop.settingsLockedUntil).toBeNull();
    f.database.shopConfiguration.update = save;
    expect(
      checkoutOfferForSettings(
        f.configuration,
        f.liveShop.checkoutOffer.jsonValue,
      ).checkboxLabel,
    ).toBe("Choose shipping protection");
    await updateCheckoutOffer(
      f.admin,
      "one.myshopify.com",
      { checkboxLabel: "", supportingText: "" },
      { database: f.database },
    );
    expect(f.configuration).toMatchObject({
      protectionCheckboxLabel: null,
      protectionSupportingText: null,
    });
    expect(f.writes[1].compareDigest).toBe("new-digest");
  });
});
