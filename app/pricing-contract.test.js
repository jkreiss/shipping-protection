import { describe, expect, test } from "vitest";
import {
  DEFAULT_RATE_BASIS_POINTS,
  formatBasisPoints,
  parsePricingContract,
  pricingContractForRule,
  validateRateBasisPoints,
} from "./pricing-contract";

const productId = "gid://shopify/Product/1";
const variantId = "gid://shopify/ProductVariant/2";

describe("pricing contract", () => {
  test("migrates a valid v1 contract at 25 basis points", () => {
    expect(
      parsePricingContract({
        schemaVersion: 1,
        enabled: true,
        productId,
        variantId,
        rateBasisPoints: DEFAULT_RATE_BASIS_POINTS,
        basis: "SHIPPABLE_PRE_DISCOUNT",
      }),
    ).toMatchObject({ schemaVersion: 1, rateBasisPoints: 25 });
  });

  test("accepts a complete v2 rule snapshot", () => {
    const contract = pricingContractForRule(
      {
        ruleId: "rule-1",
        version: 3,
        rateBasisPoints: 125,
        effectiveAt: new Date("2026-09-23T00:00:00Z"),
      },
      productId,
      variantId,
    );
    expect(parsePricingContract(contract)).toEqual(contract);
    expect(contract).toMatchObject({
      schemaVersion: 2,
      ruleVersion: 3,
      rateBasisPoints: 125,
    });
  });

  test.each([0, -1, 10_001, 1.5, Number.NaN])(
    "rejects invalid basis-point rate %s",
    (rate) => {
      expect(() => validateRateBasisPoints(rate)).toThrow(RangeError);
    },
  );

  test.each([1, 25, 10_000])("accepts rate %s", (rate) => {
    expect(validateRateBasisPoints(rate)).toBe(rate);
  });

  test("uses enabled rather than zero to disable a rule", () => {
    const rule = {
      ruleId: "rule-1",
      version: 1,
      rateBasisPoints: 25,
      effectiveAt: new Date("2026-09-23T00:00:00Z"),
    };
    expect(pricingContractForRule(rule, productId, variantId, false).enabled).toBe(
      false,
    );
    expect(() =>
      pricingContractForRule(
        { ...rule, rateBasisPoints: 0 },
        productId,
        variantId,
        false,
      ),
    ).toThrow(RangeError);
  });

  test("formats merchant-facing percentages from configuration", () => {
    expect(formatBasisPoints(25)).toBe("0.25%");
    expect(formatBasisPoints(200)).toBe("2%");
  });
});
