import { describe, expect, test } from "vitest";
import { UserFacingError } from "./user-facing-error";
import {
  DEFAULT_RATE_BASIS_POINTS,
  basisPointsToPercent,
  calculateFee,
  currencyMinorUnits,
  formatBasisPoints,
  parsePricingContract,
  percentToBasisPoints,
  pricingContractForRule,
  validateRateBasisPoints,
} from "./pricing-contract";
import feeFixtures from "../test-fixtures/pricing-fees.json";

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

  test.each([
    ["1", 100],
    ["0.25", 25],
    [" 2.5 ", 250],
    ["0.01", 1],
    ["100", 10_000],
    [1.5, 150],
  ])("converts merchant percentage %s to %s basis points", (input, expected) => {
    expect(percentToBasisPoints(input)).toBe(expected);
  });

  test.each(["", "abc", "0", "0.001", "100.01", "-1", "1e2", null])(
    "rejects invalid merchant percentage %s",
    (input) => {
      expect(() => percentToBasisPoints(input)).toThrow(UserFacingError);
    },
  );

  test("shows stored basis points as a plain percentage number", () => {
    expect(basisPointsToPercent(25)).toBe("0.25");
    expect(basisPointsToPercent(100)).toBe("1");
    expect(basisPointsToPercent(250)).toBe("2.5");
  });
});

// The Cart Transform and checkout block keep their own copies; the shared
// fixture keeps all three calculations identical.
describe("server fee calculation", () => {
  test.each(feeFixtures)("matches $name", (fixture) => {
    expect(calculateFee(fixture.amounts, fixture.rateBasisPoints, fixture.minorUnits))
      .toBe(fixture.expected);
  });

  test("uses ISO currency precision", () => {
    expect(currencyMinorUnits("JPY")).toBe(0);
    expect(currencyMinorUnits("KWD")).toBe(3);
    expect(currencyMinorUnits("CLF")).toBe(4);
    expect(currencyMinorUnits("AUD")).toBe(2);
  });
});
