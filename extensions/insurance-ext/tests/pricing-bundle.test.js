// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformWithEsbuild } from "vite";
import { beforeAll, describe, expect, test } from "vitest";
import feeFixtures from "../../../test-fixtures/pricing-fees.json";

/** @type {typeof import("../src/shipping-protection.js").calculateRoundedFee} */
let calculateRoundedFee;

beforeAll(async () => {
  const filename = new URL("../src/shipping-protection.js", import.meta.url);
  // Shopify CLI bundles UI extensions for ES6. Test the emitted code because
  // lowering BigInt exponentiation to Math.pow crashes despite source tests.
  const { code } = await transformWithEsbuild(
    readFileSync(filename, "utf8"),
    filename.pathname,
    { target: "es6", format: "cjs", minify: true, logLevel: "silent" },
  );
  calculateRoundedFee = runInNewContext(
    `${code}\nmodule.exports.calculateRoundedFee`,
    { module: { exports: {} } },
  );
});

describe("checkout pricing in the ES6 bundle", () => {
  test.each(feeFixtures)("calculates $name", (fixture) => {
    expect(
      calculateRoundedFee(
        fixture.amounts,
        fixture.rateBasisPoints,
        fixture.minorUnits,
      ),
    ).toBe(Number(fixture.expected));
  });

  test.each(["9007199254740992", "90071992547409.91"])(
    "refuses a fee that cannot retain its minor units: %s",
    (amount) => {
      expect(calculateRoundedFee([amount], 10000, 2)).toBeNull();
    },
  );
});
