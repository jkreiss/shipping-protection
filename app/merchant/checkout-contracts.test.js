import { describe, expect, test } from "vitest";
import {
  parseCheckoutOffer,
  validateCheckoutOfferChanges,
} from "./checkout-offer.js";
import { parsePricingContract } from "../pricing-contract.js";
import {
  readCheckoutOffer,
  readConfiguration,
} from "../../extensions/insurance-ext/src/shipping-protection.js";
import copyFixtures from "../../test-fixtures/checkout-copy.json";
import configurationFixtures from "../../test-fixtures/checkout-configurations.json";

function metafield(key, value) {
  return [
    {
      target: { type: "shop" },
      metafield: { namespace: "$app", key, value: JSON.stringify(value) },
    },
  ];
}

describe("shared checkout contracts", () => {
  test.each(["\u0085", "\u2028", "\u2029", "\ufeff"])(
    "rejects forbidden edge characters before trimming: %j",
    (character) => {
      expect(() =>
        validateCheckoutOfferChanges({
          checkboxLabel: `${character}Protection`,
        }),
      ).toThrow();
      expect(() =>
        validateCheckoutOfferChanges({
          supportingText: `Protection${character}`,
        }),
      ).toThrow();
    },
  );
  test.each(copyFixtures)(
    "server and extension agree on copy: $name",
    (fixture) => {
      const { checkboxLabel, supportingText, valid } = fixture;
      const offer = { schemaVersion: 1, checkboxLabel, supportingText };
      expect(Boolean(parseCheckoutOffer(offer))).toBe(valid);
      expect(
        readCheckoutOffer(metafield("shipping_protection_offer", offer)),
      ).toEqual(
        valid
          ? { checkboxLabel, supportingText }
          : { checkboxLabel: null, supportingText: null },
      );
      if (fixture.name.startsWith("forbidden")) {
        for (const field of ["checkboxLabel", "supportingText"]) {
          const singleField = {
            schemaVersion: 1,
            checkboxLabel: null,
            supportingText: null,
            [field]: offer[field],
          };
          expect(parseCheckoutOffer(singleField)).toBeNull();
          expect(
            readCheckoutOffer(
              metafield("shipping_protection_offer", singleField),
            ),
          ).toEqual({ checkboxLabel: null, supportingText: null });
          expect(() =>
            validateCheckoutOfferChanges({ [field]: offer[field] }),
          ).toThrow();
        }
      }
    },
  );

  test.each(configurationFixtures)(
    "server and extension agree on pricing: $name",
    (fixture) => {
      const value = {
        schemaVersion: 2,
        enabled: true,
        productId: "gid://shopify/Product/10",
        variantId: "gid://shopify/ProductVariant/20",
        rateBasisPoints: 25,
        basis: "SHIPPABLE_PRE_DISCOUNT",
        ruleId: "rule-1",
        ruleVersion: 1,
        effectiveAt: "2026-09-23T00:00:00.000Z",
        ...fixture.overrides,
      };
      if (fixture.omit) delete value[fixture.omit];
      expect(Boolean(parsePricingContract(value))).toBe(fixture.valid);
      expect(
        Boolean(
          readConfiguration(metafield("shipping_protection_config", value)),
        ),
      ).toBe(fixture.valid);
    },
  );
});
