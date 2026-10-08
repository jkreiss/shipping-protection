import { describe, expect, test } from "vitest";
import {
  calculateFee,
  cartTransformRun,
  currencyMinorUnits,
} from "../src/cart_transform_run";
import currencyFixtures from "../../../test-fixtures/currency-minor-units.json";
import feeFixtures from "../../../test-fixtures/pricing-fees.json";

const PRODUCT_ID = "gid://shopify/Product/1";
const PROTECTION_ID = "gid://shopify/ProductVariant/10";

function configuration(overrides = {}) {
  return {
    schemaVersion: 2,
    enabled: true,
    productId: PRODUCT_ID,
    variantId: PROTECTION_ID,
    ruleId: "rule-1",
    ruleVersion: 1,
    rateBasisPoints: 25,
    basis: "SHIPPABLE_PRE_DISCOUNT",
    effectiveAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function line({
  id,
  amount,
  variantId = `gid://shopify/ProductVariant/${id}`,
  requiresShipping = true,
  quantity = 1,
  currencyCode = "USD",
  sellingPlan = false,
  custom = false,
}) {
  return {
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    cost: { subtotalAmount: { amount, currencyCode } },
    sellingPlanAllocation: sellingPlan
      ? { sellingPlan: { id: "gid://shopify/SellingPlan/1" } }
      : null,
    merchandise: custom
      ? { __typename: "CustomProduct", requiresShipping }
      : {
          __typename: "ProductVariant",
          id: variantId,
          requiresShipping,
        },
  };
}

function input(lines, config = configuration()) {
  return {
    cartTransform: {
      configuration: config === undefined ? null : { jsonValue: config },
    },
    cart: { lines },
  };
}

function protectionLine(id = "protection", quantity = 1) {
  return line({ id, amount: "0.00", variantId: PROTECTION_ID, quantity });
}

function expectedUpdate(cartLineId, amount) {
  return {
    lineUpdate: {
      cartLineId,
      price: {
        adjustment: {
          fixedPricePerUnit: { amount },
        },
      },
    },
  };
}

describe("fee calculation", () => {
  test.each(feeFixtures)("matches $name", (fixture) => {
    expect(
      calculateFee(
        fixture.amounts,
        fixture.rateBasisPoints,
        fixture.minorUnits,
      ),
    ).toBe(fixture.expected);
  });

  test.each(currencyFixtures)(
    "uses ISO currency precision for $currencyCode",
    ({ currencyCode, minorUnits }) => {
      expect(currencyMinorUnits(currencyCode)).toBe(minorUnits);
    },
  );

  test("sums decimal inputs without floating-point drift", () => {
    expect(calculateFee(["0.10", "0.20", "99.70"], 25, 2)).toBe("0.25");
  });

  test("applies no minimum or cap", () => {
    expect(calculateFee(["1.99"], 25, 2)).toBe("0.00");
    expect(calculateFee(["1000000.00"], 25, 2)).toBe("2500.00");
  });
});

describe("cart transform", () => {
  test("updates the protection line from shippable pre-discount subtotals", () => {
    const protection = protectionLine();
    const result = cartTransformRun(
      input([line({ id: "physical", amount: "100.00" }), protection]),
    );

    expect(result.operations).toEqual([expectedUpdate(protection.id, "0.25")]);
  });

  test("excludes digital merchandise and the protection line", () => {
    const protection = protectionLine();
    const result = cartTransformRun(
      input([
        line({ id: "physical", amount: "50.00" }),
        line({ id: "digital", amount: "900.00", requiresShipping: false }),
        {
          ...protection,
          cost: { subtotalAmount: { amount: "25.00", currencyCode: "USD" } },
        },
      ]),
    );

    expect(result.operations).toEqual([expectedUpdate(protection.id, "0.13")]);
  });

  test("uses line subtotal once even when quantity is greater than one", () => {
    const protection = protectionLine();
    const result = cartTransformRun(
      input([line({ id: "three", amount: "30.00", quantity: 3 }), protection]),
    );

    expect(result.operations).toEqual([expectedUpdate(protection.id, "0.08")]);
  });

  test("includes shippable custom merchandise", () => {
    const protection = protectionLine();
    const result = cartTransformRun(
      input([
        line({ id: "custom", amount: "12.50", custom: true }),
        protection,
      ]),
    );

    expect(result.operations).toEqual([expectedUpdate(protection.id, "0.03")]);
  });

  // An unreadable configuration can't say which line is protection or what it
  // costs, so the variant's own (fallback) price stays in place.
  test.each([
    ["missing", null],
    ["zero rate", configuration({ rateBasisPoints: 0 })],
    ["rate above maximum", configuration({ rateBasisPoints: 10_001 })],
    ["wrong basis", configuration({ basis: "POST_DISCOUNT" })],
    ["invalid variant", configuration({ variantId: "10" })],
    ["unknown enabled flag", configuration({ enabled: "yes" })],
  ])("returns no operations for %s configuration", (_label, config) => {
    expect(
      cartTransformRun(
        input(
          [line({ id: "physical", amount: "100.00" }), protectionLine()],
          config,
        ),
      ),
    ).toEqual({ operations: [] });
  });

  test("accepts legacy schema v1 only at 25 basis points", () => {
    const legacy = {
      schemaVersion: 1,
      enabled: true,
      productId: PRODUCT_ID,
      variantId: PROTECTION_ID,
      rateBasisPoints: 25,
      basis: "SHIPPABLE_PRE_DISCOUNT",
    };
    const protection = protectionLine();
    expect(
      cartTransformRun(
        input([line({ id: "physical", amount: "100.00" }), protection], legacy),
      ).operations,
    ).toEqual([expectedUpdate(protection.id, "0.25")]);
  });

  test("returns no operations for a cart containing a selling plan", () => {
    expect(
      cartTransformRun(
        input([
          line({ id: "subscription", amount: "100.00", sellingPlan: true }),
          protectionLine(),
        ]),
      ),
    ).toEqual({ operations: [] });
  });

  // The protection variant carries a fallback price for when this Function
  // fails, so a protection line that shouldn't be charged is set to zero.
  test("prices protection at zero when protection is disabled", () => {
    const protection = protectionLine();
    expect(
      cartTransformRun(
        input(
          [line({ id: "physical", amount: "100.00" }), protection],
          configuration({ enabled: false }),
        ),
      ).operations,
    ).toEqual([expectedUpdate(protection.id, "0")]);
  });

  test("prices protection at zero without shippable merchandise", () => {
    const protection = protectionLine();
    expect(
      cartTransformRun(
        input([
          line({ id: "digital", amount: "100.00", requiresShipping: false }),
          protection,
        ]),
      ).operations,
    ).toEqual([expectedUpdate(protection.id, "0")]);
  });

  test("prices protection at zero when merchandise currencies differ", () => {
    const protection = protectionLine();
    expect(
      cartTransformRun(
        input([
          line({ id: "usd", amount: "100.00", currencyCode: "USD" }),
          line({ id: "eur", amount: "100.00", currencyCode: "EUR" }),
          protection,
        ]),
      ).operations,
    ).toEqual([expectedUpdate(protection.id, "0")]);
  });

  test("returns no operations without a protection line", () => {
    expect(
      cartTransformRun(input([line({ id: "physical", amount: "100.00" })])),
    ).toEqual({ operations: [] });
  });

  test("charges the fee once across duplicate protection lines", () => {
    const later = protectionLine("z-protection");
    const earlier = protectionLine("a-protection");
    const result = cartTransformRun(
      input([line({ id: "physical", amount: "100.00" }), later, earlier]),
    );

    expect(result.operations).toEqual([
      expectedUpdate(earlier.id, "0.25"),
      expectedUpdate(later.id, "0"),
    ]);
  });

  test("charges the fee on a single-unit line, not per unit", () => {
    const multiple = protectionLine("a-protection", 2);
    const single = protectionLine("z-protection");
    const result = cartTransformRun(
      input([line({ id: "physical", amount: "100.00" }), multiple, single]),
    );

    expect(result.operations).toEqual([
      expectedUpdate(multiple.id, "0"),
      expectedUpdate(single.id, "0.25"),
    ]);
  });

  test("prices every protection line at zero when none has a single unit", () => {
    // The fee can't be charged exactly across several units, so nothing is
    // charged and ingestion records the order as not protected.
    const protection = protectionLine("a-protection", 3);
    const other = protectionLine("z-protection", 2);
    const result = cartTransformRun(
      input([line({ id: "physical", amount: "100.00" }), protection, other]),
    );

    expect(result.operations).toEqual([
      expectedUpdate(protection.id, "0"),
      expectedUpdate(other.id, "0"),
    ]);
  });

  test("prices a single multi-unit protection line at zero", () => {
    const protection = protectionLine("protection", 100);
    const result = cartTransformRun(
      input([line({ id: "physical", amount: "100.00" }), protection]),
    );

    expect(result.operations).toEqual([expectedUpdate(protection.id, "0")]);
  });
});
