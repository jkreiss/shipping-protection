/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/preact";
import { h, render } from "preact";
import { signal } from "@preact/signals";
import { getExtension } from "@shopify/ui-extensions-tester";
import {
  createCartLine,
  createPickupLocationOption,
  createResult,
  createShippingOption,
} from "@shopify/ui-extensions-tester/checkout";
import {
  calculateRoundedFee,
  deliveryEligibility,
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

/** @param {Partial<import("../src/shipping-protection").CheckoutOffer>} offer */
function setOffer(offer) {
  extension.shopify.appMetafields.value = [
    ...extension.shopify.appMetafields.value,
    {
      ...appMetafield(),
      metafield: {
        ...appMetafield().metafield,
        key: "shipping_protection_offer",
        value: JSON.stringify({
          schemaVersion: 1,
          checkboxLabel: null,
          supportingText: null,
          ...offer,
        }),
      },
    },
  ];
}

beforeEach(() => {
  extension.setUp();
  // Preserve the host boundary, including reactive cart/config/capability updates.
  makeReactive(extension.shopify.lines);
  makeReactive(extension.shopify.appMetafields);
  makeReactive(extension.shopify.instructions);
  makeReactive(extension.shopify.deliveryGroups);
  extension.shopify.applyCartLinesChange = successfulMutation;
});

/** @template T @param {{value: T}} host */
function makeReactive(host) {
  const value = signal(host.value);
  Object.defineProperty(host, "value", {
    configurable: true,
    get: () => value.value,
    set: (next) => {
      value.value = next;
    },
  });
}

describe("checkout cleanup and recovery regressions", () => {
  async function mount() {
    await act(async () => {
      await renderExtension();
    });
    await act(async () => {});
  }

  /** @param {number} milliseconds */
  async function advance(milliseconds) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
    await act(async () => {});
  }

  function uncheck() {
    const checkbox = requireCheckbox();
    checkbox.checked = false;
    fireEvent.change(checkbox);
  }

  function requireRetry() {
    const button = document.querySelector("s-button");
    if (!button) throw new Error("Expected Retry control");
    return button;
  }

  test("no eligible merchandise is ineligible even when delivery groups are missing", () => {
    expect(deliveryEligibility([], new Set())).toBe("ineligible");
  });

  test.each([
    "last item removed",
    "digital only",
    "protection only",
    "disabled",
    "subscription",
    "zero fee",
  ])("removes protection during pending delivery: %s", async (state) => {
    setCheckout({ lines: [merchandiseLine(), protectionLine()] });
    extension.shopify.deliveryGroups.value = [];
    await mount();
    expect(requireCheckbox().hasAttribute("checked")).toBe(true);
    await act(async () => {
      if (state === "disabled")
        extension.shopify.appMetafields.value = [
          appMetafield(configuration({ enabled: false })),
        ];
      else
        extension.shopify.lines.value = [
          ...(state === "last item removed" || state === "protection only"
            ? []
            : [
                merchandiseLine({
                  requiresShipping: state !== "digital only",
                  sellingPlan: state === "subscription",
                  amount: state === "zero fee" ? 0.24 : 100,
                }),
              ]),
          protectionLine(),
        ];
    });
    await waitFor(() =>
      expect(
        extension.shopify.lines.value.filter(
          (line) => line.merchandise.id === PROTECTION_ID,
        ),
      ).toHaveLength(0),
    );
    expect(document.querySelector("s-checkbox")).toBeNull();
  });

  test.each(["canAddCartLine", "canUpdateCartLine"])(
    "permission loss preserves selected protection: %s",
    async (permission) => {
      setCheckout({ lines: [merchandiseLine(), protectionLine()] });
      await mount();
      await act(() => {
        extension.shopify.instructions.value = {
          ...extension.shopify.instructions.value,
          lines: {
            ...extension.shopify.instructions.value.lines,
            [permission]: false,
          },
        };
      });
      expect(requireCheckbox().hasAttribute("checked")).toBe(true);
      expect(extension.shopify.lines.value).toHaveLength(2);
    },
  );

  test("pickup removal failure keeps the actual fee and recovery control visible", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [merchandiseLine(), protectionLine({ amount: 1.5 })],
      deliveryType: "pickup",
    });
    extension.shopify.i18n.formatCurrency = (amount) => `$${amount}`;
    extension.shopify.i18n.translate =
      /** @type {typeof extension.shopify.i18n.translate} */ (
        (key, options) =>
          key === "removeProtection"
            ? `Shipping protection — ${options?.fee}`
            : key
      );
    const apply = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    extension.shopify.applyCartLinesChange = apply;
    await mount();
    expect(requireCheckbox().getAttribute("label")).toContain("$1.5");
    expect(document.body.textContent).toContain("protectionUnavailable");
    expect(document.body.textContent).toContain("mutationError");
    await advance(249);
    expect(apply).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(apply).toHaveBeenCalledTimes(2);
    await advance(999);
    expect(apply).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(apply).toHaveBeenCalledTimes(3);
    await advance(5000);
    expect(apply).toHaveBeenCalledTimes(3);
    extension.shopify.applyCartLinesChange = successfulMutation;
    await act(async () => {
      fireEvent.click(requireRetry());
    });
    await advance(0);
    expect(extension.shopify.lines.value).toHaveLength(1);
    expect(document.querySelector("s-banner")).toBeNull();
  });

  test("unavailable removal is explained and resumes when capability recovers", async () => {
    setCheckout({
      lines: [merchandiseLine(), protectionLine()],
      deliveryType: "pickup",
    });
    extension.shopify.instructions.value = {
      ...extension.shopify.instructions.value,
      lines: {
        ...extension.shopify.instructions.value.lines,
        canRemoveCartLine: false,
      },
    };
    await mount();
    expect(requireCheckbox().hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("removalUnavailable");
    await act(async () => {
      extension.shopify.instructions.value = {
        ...extension.shopify.instructions.value,
        lines: {
          ...extension.shopify.instructions.value.lines,
          canRemoveCartLine: true,
        },
      };
    });
    await waitFor(() => expect(extension.shopify.lines.value).toHaveLength(1));
  });

  test("unchecking removes every protection line using IDs refreshed after each mutation", async () => {
    setCheckout({
      lines: [
        merchandiseLine(),
        protectionLine(),
        protectionLine({ id: "duplicate" }),
      ],
    });
    extension.shopify.applyCartLinesChange = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    await mount();
    await act(async () => {
      extension.shopify.applyCartLinesChange = async (change) => {
        const result = await successfulMutation(change);
        extension.shopify.lines.value = extension.shopify.lines.value.map(
          (line) => ({ ...line, id: `${line.id}-changed` }),
        );
        return result;
      };
      uncheck();
      uncheck();
    });
    await waitFor(() => expect(extension.shopify.lines.value).toHaveLength(1));
    await waitFor(() => expect(requireCheckbox().checked).toBe(false));
  });

  test("partial buyer removal failure retains selection until Retry removes the remainder", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [
        merchandiseLine(),
        protectionLine(),
        protectionLine({ id: "duplicate", amount: 0 }),
      ],
    });
    const apply = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    extension.shopify.applyCartLinesChange = apply;
    await mount();
    apply.mockImplementationOnce(successfulMutation);
    await act(async () => {
      uncheck();
    });
    await advance(250);
    await advance(1000);
    expect(extension.shopify.lines.value).toHaveLength(2);
    expect(requireCheckbox().hasAttribute("checked")).toBe(true);
    expect(document.body.textContent).toContain("mutationError");
    extension.shopify.applyCartLinesChange = successfulMutation;
    await act(async () => {
      fireEvent.click(requireRetry());
    });
    await advance(0);
    expect(extension.shopify.lines.value).toHaveLength(1);
    expect(document.querySelector("s-banner")).toBeNull();
  });

  test.each(["returned error", "rejection", "synchronous throw"])(
    "releases the runner and recovers from %s",
    async (failure) => {
      vi.useFakeTimers();
      setCheckout({
        lines: [merchandiseLine(), protectionLine({ quantity: 3 })],
      });
      const apply = vi.fn((change) => {
        if (apply.mock.calls.length > 1) return successfulMutation(change);
        if (failure === "synchronous throw") throw new Error("failed");
        if (failure === "rejection") return Promise.reject(new Error("failed"));
        return Promise.resolve(
          createResult("applyCartLinesChange", {
            type: "error",
            message: "failed",
          }),
        );
      });
      extension.shopify.applyCartLinesChange = apply;
      await mount();
      expect(requireCheckbox().hasAttribute("disabled")).toBe(false);
      await advance(250);
      expect(extension.shopify.lines.value[1].quantity).toBe(1);
      expect(document.querySelector("s-banner")).toBeNull();
    },
  );

  test("a new rule resets failed reconciliation and writes its current contract", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [merchandiseLine(), protectionLine({ quantity: 3 })],
    });
    extension.shopify.applyCartLinesChange = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    await mount();
    await advance(250);
    await advance(1000);
    const next = configuration({
      ruleId: "rule-2",
      ruleVersion: 2,
      rateBasisPoints: 40,
    });
    extension.shopify.applyCartLinesChange = successfulMutation;
    await act(async () => {
      extension.shopify.appMetafields.value = [appMetafield(next)];
    });
    expect(extension.shopify.lines.value[1].attributes).toEqual(
      protectionAttributes(next),
    );
    expect(document.querySelector("s-banner")).toBeNull();
  });

  test("successful mutations wait for published cart changes before further cleanup", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [
        merchandiseLine(),
        protectionLine(),
        protectionLine({ id: "duplicate" }),
      ],
      deliveryType: "pickup",
    });
    const apply = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = apply;
    await mount();
    await advance(5000);
    expect(apply).toHaveBeenCalledTimes(1);
    await act(async () => {
      extension.shopify.lines.value = [
        merchandiseLine(),
        protectionLine({ id: "fresh" }),
      ];
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0].id).toBe("gid://shopify/CartLine/fresh");
  });

  test.each(["buyer removes", "rule changes", "capabilities change"])(
    "acknowledged success waits for cart publication when %s",
    async (change) => {
      vi.useFakeTimers();
      setCheckout({
        lines: [merchandiseLine(), protectionLine({ quantity: 3 })],
      });
      const apply = vi
        .fn()
        .mockResolvedValue(createResult("applyCartLinesChange"));
      extension.shopify.applyCartLinesChange = apply;
      await mount();
      await act(async () => {
        if (change === "buyer removes") uncheck();
        else if (change === "rule changes")
          extension.shopify.appMetafields.value = [
            appMetafield(configuration({ ruleId: "rule-2", ruleVersion: 2 })),
          ];
        else
          extension.shopify.instructions.value = {
            ...extension.shopify.instructions.value,
            lines: {
              ...extension.shopify.instructions.value.lines,
              canAddCartLine: false,
            },
          };
      });
      await advance(5000);
      expect(apply).toHaveBeenCalledTimes(1);
      // Once the host publishes the first result, the current action can run.
      extension.shopify.applyCartLinesChange = successfulMutation;
      await act(async () => {
        extension.shopify.lines.value = [
          merchandiseLine(),
          protectionLine({ id: "published" }),
        ];
      });
      expect(extension.shopify.lines.value).toHaveLength(
        change === "buyer removes" ? 1 : 2,
      );
      if (change === "rule changes")
        expect(extension.shopify.lines.value[1].attributes[0].value).toBe(
          "rule-2",
        );
    },
  );

  test.each(["add", "remove", "update"])(
    "an unrelated cart update does not repeat an acknowledged %s",
    async (operation) => {
      vi.useFakeTimers();
      setCheckout({
        lines: [
          merchandiseLine(),
          ...(operation === "add"
            ? []
            : [protectionLine({ quantity: operation === "update" ? 3 : 1 })]),
        ],
        deliveryType: operation === "remove" ? "pickup" : "shipping",
      });
      const apply = vi
        .fn()
        .mockResolvedValue(createResult("applyCartLinesChange"));
      extension.shopify.applyCartLinesChange = apply;
      await mount();
      if (operation === "add")
        await act(async () => {
          const checkbox = requireCheckbox();
          checkbox.checked = true;
          fireEvent.change(checkbox);
        });
      await act(async () => {
        extension.shopify.lines.value = [
          merchandiseLine({ amount: 200 }),
          ...extension.shopify.lines.value.filter(
            (line) => line.merchandise.id === PROTECTION_ID,
          ),
        ];
      });
      await advance(5000);
      expect(apply).toHaveBeenCalledTimes(1);
      await act(async () => {
        await successfulMutation(apply.mock.calls[0][0]);
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(document.querySelector("s-banner")).toBeNull();
    },
  );

  test("unmount cancels automatic retries", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [merchandiseLine(), protectionLine({ quantity: 3 })],
    });
    const apply = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    extension.shopify.applyCartLinesChange = apply;
    await mount();
    await act(() => {
      render(null, document.body);
    });
    await advance(5000);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test("cart satisfaction cancels obsolete retry and clears its error", async () => {
    vi.useFakeTimers();
    setCheckout({
      lines: [merchandiseLine(), protectionLine({ quantity: 3 })],
    });
    const apply = vi
      .fn()
      .mockResolvedValue({ type: "error", message: "failed" });
    extension.shopify.applyCartLinesChange = apply;
    await mount();
    await act(async () => {
      extension.shopify.lines.value = [merchandiseLine(), protectionLine()];
    });
    await advance(5000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(document.querySelector("s-banner")).toBeNull();
  });
});

afterEach(() => {
  render(null, document.body);
  extension.tearDown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** @param {import("@shopify/ui-extensions/checkout").CartLineChange} change */
async function successfulMutation(change) {
  const lines = extension.shopify.lines.value;
  if (change.type === "removeCartLine") {
    if (!lines.some(({ id }) => id === change.id))
      throw new Error("Stale cart ID");
    extension.shopify.lines.value = lines.filter(({ id }) => id !== change.id);
  } else if (change.type === "updateCartLine") {
    extension.shopify.lines.value = lines.map((line) =>
      line.id === change.id
        ? {
            ...line,
            quantity: change.quantity ?? line.quantity,
            attributes: change.attributes ?? line.attributes,
          }
        : line,
    );
  } else {
    extension.shopify.lines.value = [...lines, protectionLine()];
  }
  return createResult("applyCartLinesChange");
}

describe("shipping protection quote", () => {
  test.each(["9007199254740992", "90071992547409.91"])(
    "refuses a final fee that cannot safely retain its minor units: %s",
    (amount) => {
      expect(calculateRoundedFee([amount], 10000, 2)).toBeNull();
    },
  );

  // Deferred by scope: type/title is not a unique discount identity.
  test.fails(
    "DEFERRED: distinct same-titled line and order discounts preserve the pre-discount fee",
    () => {
      const orderDiscount = {
        type: "automatic",
        title: "Automatic discount",
        discountedAmount: { amount: 10, currencyCode: "USD" },
      };
      expect(
        reconstructQuote(
          [merchandiseLine({ amount: 80, discounts: [20] })],
          configuration(),
          [orderDiscount],
        ),
      ).toEqual({ amount: 0.25, currencyCode: "USD" });
    },
  );
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
  test("keeps protection opt-in with custom copy across remounts", async () => {
    setCheckout();
    setOffer({
      checkboxLabel: "Choose shipping protection",
    });
    const apply = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = apply;
    await act(async () => {
      await renderExtension();
    });
    await act(async () => {});
    expect(requireCheckbox().hasAttribute("checked")).toBe(false);
    expect(requireCheckbox().getAttribute("label")).toContain(
      "Choose shipping protection",
    );
    await act(async () => {
      render(null, document.body);
    });
    await act(async () => {
      await renderExtension();
    });
    expect(requireCheckbox().hasAttribute("checked")).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
  test.each([
    {
      schemaVersion: 9,
      checkboxLabel: null,
      supportingText: null,
    },
    {
      schemaVersion: 1,
      checkboxLabel: null,
      supportingText: 42,
    },
    {
      schemaVersion: 1,
      checkboxLabel: "Invalid\u0000label",
      supportingText: null,
    },
  ])("uses opt-in defaults for malformed offer data: %j", async (offer) => {
    setCheckout();
    extension.shopify.appMetafields.value = [
      ...extension.shopify.appMetafields.value,
      {
        ...appMetafield(),
        metafield: {
          ...appMetafield().metafield,
          key: "shipping_protection_offer",
          value: JSON.stringify(offer),
        },
      },
    ];
    const apply = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = apply;
    await renderExtension();
    await act(async () => {});
    expect(requireCheckbox().hasAttribute("checked")).toBe(false);
    expect(requireCheckbox().getAttribute("label")).toBe("checkboxLabel");
    expect(apply).not.toHaveBeenCalled();
  });

  test("uses merchant copy while keeping the fee visible", async () => {
    setCheckout();
    setOffer({
      checkboxLabel: "Choose shipping protection",
      supportingText: "For packages stolen after delivery.",
    });
    extension.shopify.i18n.translate =
      /** @type {typeof extension.shopify.i18n.translate} */ (
        (key) =>
          ({
            checkboxLabel: "Add shipping protection",
            supportingText: "Covers packages stolen after delivery.",
          })[key] ?? key
      );
    extension.shopify.i18n.formatCurrency = () => "$0.25";
    await renderExtension();
    expect(requireCheckbox().getAttribute("label")).toBe(
      "Choose shipping protection — $0.25",
    );
    expect(document.querySelector("s-text")?.textContent).toBe(
      "For packages stolen after delivery.",
    );
  });

  test("renders arbitrary merchant wording and markup as literal text", async () => {
    setCheckout();
    const supportingText =
      "Lost or damaged packages.\n<script>alert(1)</script>";
    setOffer({
      checkboxLabel: "Protect my parcel < $5",
      supportingText,
    });
    extension.shopify.i18n.formatCurrency = () => "$0.25";
    await renderExtension();
    expect(requireCheckbox().getAttribute("label")).toBe(
      "Protect my parcel < $5 — $0.25",
    );
    expect(document.querySelector("s-text")?.textContent).toBe(supportingText);
    expect(document.querySelector("script")).toBeNull();
  });

  test.each(["no delivery groups", "no selected option", "rates loading"])(
    "offers protection before an address is entered: %s",
    async (state) => {
      setCheckout();
      extension.shopify.deliveryGroups.value =
        state === "no delivery groups"
          ? []
          : extension.shopify.deliveryGroups.value.map((group) => ({
              ...group,
              selectedDeliveryOption: undefined,
              deliveryOptions:
                state === "rates loading" ? [] : group.deliveryOptions,
            }));
      const applyCartLinesChange = vi
        .fn()
        .mockResolvedValue(createResult("applyCartLinesChange"));
      extension.shopify.applyCartLinesChange = applyCartLinesChange;
      const formatCurrency = vi.spyOn(extension.shopify.i18n, "formatCurrency");
      await renderExtension();

      const checkbox = requireCheckbox();
      expect(checkbox.hasAttribute("checked")).toBe(false);
      expect(applyCartLinesChange).not.toHaveBeenCalled();
      expect(formatCurrency).toHaveBeenCalledWith(0.25, {
        currency: "USD",
      });

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
    },
  );

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
    await waitFor(() => expect(applyCartLinesChange).toHaveBeenCalledTimes(1));
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

    await waitFor(() => expect(applyCartLinesChange).toHaveBeenCalledTimes(1));
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

  test("keeps protection visible and allows removal while delivery options reload", async () => {
    const protection = protectionLine();
    setCheckout({ lines: [merchandiseLine(), protection] });
    extension.shopify.deliveryGroups.value =
      extension.shopify.deliveryGroups.value.map((group) => ({
        ...group,
        selectedDeliveryOption: undefined,
      }));
    const applyCartLinesChange = vi
      .fn()
      .mockResolvedValue(createResult("applyCartLinesChange"));
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    const checkbox = requireCheckbox();
    expect(checkbox.hasAttribute("checked")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyCartLinesChange).not.toHaveBeenCalled();

    checkbox.checked = false;
    fireEvent.change(checkbox);
    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: protection.id,
        quantity: 1,
      });
    });
  });

  test("removes early protection when the buyer later selects store pickup", async () => {
    const physical = merchandiseLine();
    const protection = protectionLine();
    setCheckout({ lines: [physical, protection] });
    const deliveryGroups = signal(/** @type {DeliveryGroup[]} */ ([]));
    // The tester's default signals are static; use a reactive value for transitions.
    extension.shopify.deliveryGroups = {
      ...extension.shopify.deliveryGroups,
      get value() {
        return deliveryGroups.value;
      },
    };
    const applyCartLinesChange = vi.fn(successfulMutation);
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    expect(requireCheckbox().hasAttribute("checked")).toBe(true);
    expect(applyCartLinesChange).not.toHaveBeenCalled();

    await act(() => {
      deliveryGroups.value = [deliveryGroup([physical.id])];
    });
    expect(requireCheckbox().hasAttribute("checked")).toBe(true);
    expect(applyCartLinesChange).not.toHaveBeenCalled();

    await act(() => {
      deliveryGroups.value = [deliveryGroup([physical.id], "pickup")];
    });

    await waitFor(() =>
      expect(document.body.querySelector("s-checkbox")).toBeNull(),
    );
    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: protection.id,
        quantity: 1,
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
    const applyCartLinesChange = vi.fn(successfulMutation);
    extension.shopify.applyCartLinesChange = applyCartLinesChange;
    await renderExtension();

    await waitFor(() =>
      expect(document.body.querySelector("s-checkbox")).toBeNull(),
    );
    await waitFor(() => {
      expect(applyCartLinesChange).toHaveBeenCalledWith({
        type: "removeCartLine",
        id: protection.id,
        quantity: 1,
      });
    });
  });
});
