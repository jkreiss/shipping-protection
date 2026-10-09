// @vitest-environment node

// The server, the Cart Transform Function, and the checkout block each keep a
// copy of the currency table, the fee rounding, and the pricing-contract check,
// because Shopify bundles each extension on its own. These tests run the three
// copies side by side over the same inputs, so a change to one copy that the
// others don't make fails here. The block is also run as Shopify CLI ships it
// (an ES6 bundle), which is where its BigInt arithmetic once broke.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";
import { beforeAll, describe, expect, test } from "vitest";
import * as server from "./pricing-contract.js";
import * as transform from "../extensions/shipping-protection-transform/src/cart_transform_run.js";
import * as block from "../extensions/insurance-ext/src/shipping-protection.js";
import currencyFixtures from "../test-fixtures/currency-minor-units.json";
import configurationFixtures from "../test-fixtures/checkout-configurations.json";

/** @type {typeof block.calculateRoundedFee} */
let bundledRoundedFee;

beforeAll(async () => {
  const filename = new URL("../extensions/insurance-ext/src/shipping-protection.js", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(filename, "utf8"),
    filename.pathname,
    { target: "es6", format: "cjs", minify: true, logLevel: "silent" },
  );
  bundledRoundedFee = runInNewContext(
    `${code}\nmodule.exports.calculateRoundedFee`,
    { module: { exports: {} } },
  );
});

// Deterministic, so a failure reproduces.
function random(seed) {
  let state = seed;
  return (limit) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % limit;
  };
}

function decimal(digits, scaleDigits) {
  const text = digits.toString().padStart(scaleDigits + 1, "0");
  return scaleDigits === 0 ? text : `${text.slice(0, -scaleDigits)}.${text.slice(-scaleDigits)}`;
}

const RATES = [1, 2, 3, 7, 25, 33, 50, 99, 100, 125, 250, 333, 999, 5000, 9999, 10_000];
// Every currency's precision, plus 1. No currency uses more than 4; the block
// refuses those, so they aren't compared.
const MINOR_UNITS = [0, 1, 2, 3, 4];

const AMOUNT_SETS = [
  ["0"], ["0.00"], ["1"], ["0.01"], ["0.005"], ["1.99"], ["2"], ["2.00"],
  ["39.99"], ["199.99"], ["200"], ["999999.995"], ["12345.6789"], ["00012.50"],
  ["0.10000000000000001"], ["100.00000000000001"], ["1000000000000000.00"],
  ["9007199254740992"], ["90071992547409.91"],
  ["0.10", "0.20", "99.70"], ["19.99", "5.01"], ["1.5", "2.25", "3.125"], ["0", "0"],
];

// Subtotals that land exactly on half a minor unit, and one unit either side.
function halfwayAmounts(rateBasisPoints, minorUnits) {
  const scaleDigits = 8;
  const amounts = [];
  for (let k = 0n; k < 4n; k += 1n) {
    const numerator = (2n * k + 1n) * 10n ** BigInt(4 + scaleDigits);
    const denominator = 2n * BigInt(rateBasisPoints) * 10n ** BigInt(minorUnits);
    if (numerator % denominator !== 0n) continue;
    const scaled = numerator / denominator;
    for (const value of [scaled - 1n, scaled, scaled + 1n]) {
      if (value >= 0n) amounts.push([decimal(value, scaleDigits)]);
    }
  }
  return amounts;
}

function randomAmountSets(count) {
  const next = random(20_261_009);
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + next(4) }, () => {
      const scaleDigits = next(7);
      return decimal(BigInt(next(1_000_000_000)) * BigInt(1 + next(1000)), scaleDigits);
    }),
  );
}

function feeCases() {
  const cases = [];
  for (const rateBasisPoints of RATES) {
    for (const minorUnits of MINOR_UNITS) {
      for (const amounts of [...AMOUNT_SETS, ...halfwayAmounts(rateBasisPoints, minorUnits)]) {
        cases.push({ amounts, rateBasisPoints, minorUnits });
      }
    }
  }
  const next = random(7);
  for (const amounts of randomAmountSets(400)) {
    cases.push({ amounts, rateBasisPoints: RATES[next(RATES.length)], minorUnits: MINOR_UNITS[next(MINOR_UNITS.length)] });
  }
  return cases;
}

const INVALID_FEE_CASES = [
  { amounts: [], rateBasisPoints: 25, minorUnits: 2 },
  ...[["-1.00"], ["1e3"], [" 1.00"], ["1."], [".5"], ["1,000.00"], ["NaN"], ["1.00", "abc"]]
    .map((amounts) => ({ amounts, rateBasisPoints: 25, minorUnits: 2 })),
  ...[0, -1, 10_001, 2.5, Number.NaN].map((rateBasisPoints) => ({ amounts: ["100.00"], rateBasisPoints, minorUnits: 2 })),
  ...[-1, 1.5, Number.NaN].map((minorUnits) => ({ amounts: ["100.00"], rateBasisPoints: 25, minorUnits })),
];

// The block passes the fee to Shopify's number formatter, so it refuses a fee
// that a JavaScript number can't hold to the minor unit rather than show a
// rounded one.
function asCheckoutNumber(fee, minorUnits) {
  if (fee === null) return null;
  const minor = BigInt(fee.replace(".", ""));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const amount = Number(fee);
  const [whole, fraction = ""] = String(amount).split(".");
  return /^\d+$/.test(whole) && fraction.length <= minorUnits &&
    BigInt(whole + fraction.padEnd(minorUnits, "0")) === minor
    ? amount
    : null;
}

describe("the three pricing copies agree", () => {
  test("on every currency's minor units", () => {
    const codes = new Set([
      ...Intl.supportedValuesOf("currency"),
      ...currencyFixtures.map(({ currencyCode }) => currencyCode),
      "", "usd", "XXX", "XTS",
    ]);
    for (const code of codes) {
      const expected = server.currencyMinorUnits(code);
      expect({ code, minorUnits: transform.currencyMinorUnits(code) }).toEqual({ code, minorUnits: expected });
      expect({ code, minorUnits: block.currencyMinorUnits(code) }).toEqual({ code, minorUnits: expected });
    }
  });

  test("on the fee, including rounding edges", () => {
    const cases = feeCases();
    expect(cases.length).toBeGreaterThan(2000);
    for (const fixture of [...cases, ...INVALID_FEE_CASES]) {
      const { amounts, rateBasisPoints, minorUnits } = fixture;
      const expected = server.calculateFee(amounts, rateBasisPoints, minorUnits);
      expect({ fixture, fee: transform.calculateFee(amounts, rateBasisPoints, minorUnits) })
        .toEqual({ fixture, fee: expected });
      const blockExpected = asCheckoutNumber(expected, minorUnits);
      expect({ fixture, fee: block.calculateRoundedFee(amounts, rateBasisPoints, minorUnits) })
        .toEqual({ fixture, fee: blockExpected });
      expect({ fixture, fee: bundledRoundedFee(amounts, rateBasisPoints, minorUnits) })
        .toEqual({ fixture, fee: blockExpected });
    }
  });

  const PROTECTION_VARIANT = "gid://shopify/ProductVariant/20";
  const baseConfiguration = {
    schemaVersion: 2,
    enabled: true,
    productId: "gid://shopify/Product/10",
    variantId: PROTECTION_VARIANT,
    rateBasisPoints: 25,
    basis: "SHIPPABLE_PRE_DISCOUNT",
    ruleId: "rule-1",
    ruleVersion: 1,
    effectiveAt: "2026-09-23T00:00:00.000Z",
  };
  const contractCases = [
    ...configurationFixtures.map((fixture) => {
      const value = { ...baseConfiguration, ...fixture.overrides };
      if (fixture.omit) delete value[fixture.omit];
      return { name: fixture.name, value };
    }),
    { name: "null", value: null },
    { name: "string", value: "config" },
    { name: "array", value: [] },
    { name: "extra field", value: { ...baseConfiguration, extra: true } },
    { name: "rate 3333", value: { ...baseConfiguration, rateBasisPoints: 3333 } },
    { name: "legacy with rule fields", value: { ...baseConfiguration, schemaVersion: 1 } },
    { name: "legacy without rule fields", value: { schemaVersion: 1, enabled: true, productId: baseConfiguration.productId, variantId: PROTECTION_VARIANT, rateBasisPoints: 25, basis: "SHIPPABLE_PRE_DISCOUNT" } },
    { name: "date-only effectiveAt", value: { ...baseConfiguration, effectiveAt: "2026-09-23" } },
    { name: "empty effectiveAt", value: { ...baseConfiguration, effectiveAt: "" } },
    { name: "fractional rate", value: { ...baseConfiguration, rateBasisPoints: 25.5 } },
    { name: "schemaVersion as text", value: { ...baseConfiguration, schemaVersion: "2" } },
  ];

  // The Function doesn't export its parser, so run it on a cart with one
  // shippable line and one single-unit protection line: an accepted contract
  // prices the protection line, a rejected one leaves the cart unchanged.
  function functionReading(value) {
    const result = transform.cartTransformRun({
      cartTransform: { configuration: { jsonValue: value } },
      cart: {
        lines: [
          { id: "gid://shopify/CartLine/1", quantity: 1, sellingPlanAllocation: null,
            cost: { subtotalAmount: { amount: "123.45", currencyCode: "USD" } },
            merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/1", requiresShipping: true } },
          { id: "gid://shopify/CartLine/2", quantity: 1, sellingPlanAllocation: null,
            cost: { subtotalAmount: { amount: "0.00", currencyCode: "USD" } },
            merchandise: { __typename: "ProductVariant", id: PROTECTION_VARIANT, requiresShipping: false } },
        ],
      },
    });
    return result.operations[0]?.lineUpdate.price.adjustment.fixedPricePerUnit.amount ?? null;
  }

  test.each(contractCases)("on accepting the pricing contract: $name", ({ value }) => {
    const parsed = server.parsePricingContract(value);
    const read = block.readConfiguration([{
      target: { type: "shop" },
      metafield: { namespace: "$app", key: "shipping_protection_config", value: JSON.stringify(value) },
    }]);
    expect(Boolean(read)).toBe(Boolean(parsed));
    expect(functionReading(value)).toBe(
      parsed
        ? parsed.enabled ? server.calculateFee(["123.45"], parsed.rateBasisPoints, 2) : "0"
        : null,
    );
    if (parsed && read) {
      expect({ enabled: read.enabled, variantId: read.variantId, rateBasisPoints: read.rateBasisPoints })
        .toEqual({ enabled: parsed.enabled, variantId: parsed.variantId, rateBasisPoints: parsed.rateBasisPoints });
    }
  });
});
