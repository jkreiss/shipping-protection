/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/preact";
import { h, render } from "preact";
import { getExtension } from "@shopify/ui-extensions-tester";
import {
  createCartLine,
  createPickupLocationOption,
  createResult,
  createShippingOption,
} from "@shopify/ui-extensions-tester/checkout";
import {
  calculateRoundedFee,
  protectionAttributes,
  reconstructQuote,
} from "../src/shipping-protection";
import { ShippingProtection } from "../src/Checkout";
import feeFixtures from "../../../test-fixtures/pricing-fees.json";

const PRODUCT_ID = "gid://shopify/Product/10";
const PROTECTION_ID = "gid://shopify/ProductVariant/20";
const extension = getExtension("purchase.checkout.block.render");

/**
 * @typedef {import("@shopify/ui-extensions/checkout").AppMetafieldEntry} AppMetafieldEntry
 * @typedef {import("@shopify/ui-extensions/checkout").CartLine} CartLine
 * @typedef {import("@shopify/ui-extensions/checkout").CartLineChangeResult} CartLineChangeResult
 * @typedef {import("@shopify/ui-extensions/checkout").DeliveryGroup} DeliveryGroup
 * @typedef {import("@shopify/ui-extensions/checkout").DeliveryOption} DeliveryOption
 * @typedef {"shipping" | "local" | "pickupPoint" | "pickup"} DeliveryType
 * @typedef {{
 *   schemaVersion: 1 | 2,
 *   enabled: boolean,
 *   productId: string,
 *   variantId: string,
 *   rateBasisPoints: number,
 *   basis: "SHIPPABLE_PRE_DISCOUNT",
 *   ruleId?: string,
 *   ruleVersion?: number,
 *   effectiveAt?: string
 * }} TestConfiguration
 * @typedef {{
 *   lines?: CartLine[],
 *   deliveryType?: DeliveryType,
 *   config?: TestConfiguration,
 *   withConfiguration?: boolean
 * }} CheckoutOptions
 */

async function renderExtension() {
  render(h(ShippingProtection, {}), document.body);
  await Promise.resolve();
}

/**
 * @param {Partial<TestConfiguration>} [overrides]
 * @returns {TestConfiguration}
 */
function configuration(overrides = {}) {
  return /** @type {TestConfiguration} */ ({
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
  });
}

/**
 * @param {TestConfiguration} [config]
 * @returns {AppMetafieldEntry}
 */
function appMetafield(config = configuration()) {
  return {
    target: { type: "shop", id: "gid://shopify/Shop/1" },
    metafield: {
      namespace: "$app",
      key: "shipping_protection_config",
      value: JSON.stringify(config),
      valueType: "json_string",
      type: "json",
    },
  };
}

/**
 * @param {{
 *   id?: string,
 *   amount?: number,
 *   requiresShipping?: boolean,
 *   sellingPlan?: boolean,
 *   discounts?: number[],
 *   attributes?: {key: string, value: string}[]
 * }} [options]
 */
function merchandiseLine({
  id = "physical",
  amount = 100,
  requiresShipping = true,
  sellingPlan = false,
  discounts = [],
  attributes = [],
} = {}) {
  const defaults = createCartLine();
  return createCartLine({
    id: `gid://shopify/CartLine/${id}`,
    attributes,
    merchandise: {
      ...defaults.merchandise,
      id: `gid://shopify/ProductVariant/${id}`,
      requiresShipping,
      ...(sellingPlan
        ? {
            sellingPlan: {
              id: "gid://shopify/SellingPlan/1",
              recurringDeliveries: true,
            },
          }
        : {}),
    },
    cost: { totalAmount: { amount, currencyCode: "USD" } },
    discountAllocations: discounts.map((discountedAmount) => ({
      type: "automatic",
      title: "Automatic discount",
      discountedAmount: { amount: discountedAmount, currencyCode: "USD" },
    })),
  });
}

/**
 * @param {{id?: string, amount?: number, quantity?: number, config?: TestConfiguration}} [options]
 */
function protectionLine({
  id = "protection",
  amount = 0.25,
  quantity = 1,
  config = configuration(),
} = {}) {
  const defaults = createCartLine();
  return createCartLine({
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    attributes: protectionAttributes(config),
    merchandise: {
      ...defaults.merchandise,
      id: PROTECTION_ID,
      requiresShipping: false,
    },
    cost: { totalAmount: { amount, currencyCode: "USD" } },
  });
}

/**
 * @param {string[]} lineIds
 * @param {DeliveryType} [type]
 * @param {"oneTimePurchase" | "subscription"} [groupType]
 * @returns {DeliveryGroup}
 */
function deliveryGroup(
  lineIds,
  type = "shipping",
  groupType = "oneTimePurchase",
) {
  /** @type {DeliveryOption} */
  let deliveryOption;
  if (type === "pickup") {
    deliveryOption = createPickupLocationOption({ handle: "selected" });
  } else if (type === "pickupPoint") {
    deliveryOption = /** @type {DeliveryOption} */ ({
      type: "pickupPoint",
      handle: "selected",
      code: "PICKUP_POINT",
      metafields: [],
      carrier: {},
      cost: { amount: 0, currencyCode: "USD" },
      costAfterDiscounts: { amount: 0, currencyCode: "USD" },
      location: {
        handle: "point-1",
        name: "Collection point",
        address: { countryCode: "US" },
      },
    });
  } else {
    deliveryOption = createShippingOption({ type, handle: "selected" });
  }

  return {
    id: "gid://shopify/DeliveryGroup/1",
    targetedCartLines: lineIds.map((id) => ({ id })),
    deliveryOptions: [deliveryOption],
    selectedDeliveryOption: { handle: "selected" },
    groupType,
    isDeliveryRequired: true,
  };
}

/**
 * @param {CheckoutOptions} [options]
 */
function setCheckout({
  lines = [merchandiseLine()],
  deliveryType = "shipping",
  config = configuration(),
  withConfiguration = true,
} = {}) {
  extension.shopify.lines.value = lines;
  extension.shopify.appMetafields.value = withConfiguration
    ? [appMetafield(config)]
    : [];
  extension.shopify.deliveryGroups.value = [
    deliveryGroup(
      lines
        .filter((line) => line.merchandise.requiresShipping)
        .map((line) => line.id),
      deliveryType,
    ),
  ];
}

function requireCheckbox() {
  const checkbox = document.body.querySelector("s-checkbox");
  if (!checkbox) throw new Error("Expected Shipping Protection checkbox.");
  return checkbox;
}

beforeEach(() => {
  extension.setUp();
});

afterEach(() => {
  render(null, document.body);
  extension.tearDown();
  vi.restoreAllMocks();
});

describe("shipping protection quote", () => {
  test("reconstructs the pre-discount quote from totals and allocations", () => {
    const quote = reconstructQuote(
      [merchandiseLine({ amount: 80, discounts: [15, 5] })],
      configuration(),
    );

    expect(quote).toEqual({ amount: 0.25, currencyCode: "USD" });
  });

  test.each(feeFixtures)("matches Function fixture: $name", (fixture) => {
    expect(
      calculateRoundedFee(
        fixture.amounts,
        fixture.rateBasisPoints,
        fixture.minorUnits,
      ),
    ).toBe(Number(fixture.expected));
  });
});

describe("shipping protection checkout UI", () => {
  test.each(["shipping", "local", "pickupPoint"])(
    "renders an unchecked offer for eligible %s delivery",
    async (deliveryType) => {
      setCheckout({
        deliveryType: /** @type {DeliveryType} */ (deliveryType),
      });
      await renderExtension();

      const checkbox = requireCheckbox();
      expect(Boolean(checkbox.checked)).toBe(false);
      expect(checkbox.getAttribute("label")).toBe("checkboxLabel");
      expect(document.body.textContent).toContain("supportingText");
    },
  );

  test.each([
    ["digital-only", { lines: [merchandiseLine({ requiresShipping: false })] }],
    ["subscription", { lines: [merchandiseLine({ sellingPlan: true })] }],
    ["direct pickup", { deliveryType: "pickup" }],
    ["zero-rounded fee", { lines: [merchandiseLine({ amount: 0.24 })] }],
    ["disabled configuration", { config: configuration({ enabled: false }) }],
    ["missing configuration", { withConfiguration: false }],
  ])("does not render for a %s checkout", async (_name, checkout) => {
    setCheckout(/** @type {CheckoutOptions} */ (checkout));
    await renderExtension();

    expect(document.body.querySelector("s-checkbox")).toBeNull();
  });

  test("does not render when cart-line mutations are unavailable", async () => {
    setCheckout();
    extension.shopify.instructions.value = {
      ...extension.shopify.instructions.value,
      lines: {
        ...extension.shopify.instructions.value.lines,
        canAddCartLine: false,
      },
    };
    await renderExtension();

    expect(document.body.querySelector("s-checkbox")).toBeNull();
  });

  test("adds exactly one configured variant", async () => {
    setCheckout();
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    const checkbox = requireCheckbox();
    checkbox.checked = true;
    fireEvent.change(checkbox);

    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "addCartLine",
        merchandiseId: PROTECTION_ID,
        quantity: 1,
        attributes: protectionAttributes(configuration()),
      });
    });
    expect(applyCartLinesChange).toHaveBeenCalledTimes(1);
  });

  test("derives checked state and displayed fee from the existing line", async () => {
    const physical = merchandiseLine();
    setCheckout({ lines: [physical, protectionLine({ amount: 1.5 })] });
    const formatCurrency = vi.fn((amount) => `$${amount}`);
    extension.shopify.i18n.formatCurrency = formatCurrency;
    await renderExtension();

    expect(requireCheckbox().hasAttribute("checked")).toBe(true);
    expect(formatCurrency).toHaveBeenCalledWith(1.5, { currency: "USD" });
  });

  test("removes the current protection cart-line ID", async () => {
    const current = protectionLine();
    setCheckout({ lines: [merchandiseLine(), current] });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    const checkbox = requireCheckbox();
    checkbox.checked = false;
    fireEvent.change(checkbox);

    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: current.id,
        quantity: 1,
      });
    });
  });

  test("blocks rapid repeated toggles while a mutation is pending", async () => {
    setCheckout();
    /** @type {(result: CartLineChangeResult) => void} */
    let resolveMutation = () => {};
    /** @type {Promise<CartLineChangeResult>} */
    const mutation = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    const applyCartLinesChange = vi.fn().mockReturnValue(mutation);
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    const checkbox = requireCheckbox();
    checkbox.checked = true;
    fireEvent.change(checkbox);
    fireEvent.change(checkbox);

    expect(applyCartLinesChange).toHaveBeenCalledTimes(1);
    resolveMutation(createResult("applyCartLinesChange"));
    await waitFor(() => expect(checkbox.hasAttribute("disabled")).toBe(false));
  });

  test("restores actual state and shows a localized mutation error", async () => {
    setCheckout();
    extension.shopify.applyCartLinesChange = vi.fn().mockResolvedValue(
      createResult("applyCartLinesChange", {
        type: "error",
        message: "internal error",
      }),
    );
    await renderExtension();

    const checkbox = requireCheckbox();
    checkbox.checked = true;
    fireEvent.change(checkbox);

    await waitFor(() => {
      expect(document.body.querySelector("s-banner")?.textContent).toBe(
        "mutationError",
      );
      expect(requireCheckbox().checked).toBe(false);
    });
  });

  test("reconciles duplicate protection lines to one", async () => {
    const duplicate = protectionLine({ id: "duplicate" });
    setCheckout({
      lines: [merchandiseLine(), protectionLine(), duplicate],
    });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: duplicate.id,
        quantity: 1,
      });
    });
  });

  test("leaves merchandise that carries protection properties in the cart", async () => {
    const tagged = merchandiseLine({
      attributes: protectionAttributes(configuration()),
    });
    setCheckout({ lines: [tagged] });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    expect(Boolean(requireCheckbox().checked)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyCartLinesChange).not.toHaveBeenCalled();
  });

  test("reconciles a non-unit protection line", async () => {
    const nonUnit = protectionLine({ quantity: 3 });
    setCheckout({ lines: [merchandiseLine(), nonUnit] });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "updateCartLine",
        id: nonUnit.id,
        quantity: 1,
        attributes: protectionAttributes(configuration()),
      });
    });
  });

  test("reconciles protection provenance after the active rule changes", async () => {
    const previous = configuration({ ruleId: "old-rule", ruleVersion: 1 });
    const current = configuration({
      ruleId: "new-rule",
      ruleVersion: 2,
      rateBasisPoints: 40,
    });
    const stale = protectionLine({ config: previous });
    setCheckout({ lines: [merchandiseLine(), stale], config: current });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "updateCartLine",
        id: stale.id,
        quantity: 1,
        attributes: protectionAttributes(current),
      });
    });
  });

  test.each([
    ["direct pickup", "pickup", false],
    ["subscription", "shipping", true],
  ])("removes protection after a %s transition", async (_name, type, plan) => {
    const protection = protectionLine();
    const physical = merchandiseLine({ sellingPlan: plan });
    setCheckout({
      lines: [physical, protection],
      deliveryType: /** @type {DeliveryType} */ (type),
    });
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    expect(document.body.querySelector("s-checkbox")).toBeNull();
    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: protection.id,
        quantity: 1,
      });
    });
  });
});
