const CONFIG_NAMESPACE = "$app";
const CONFIG_KEY = "shipping_protection_config";
const OFFER_KEY = "shipping_protection_offer";
const CONFIG_BASIS = "SHIPPABLE_PRE_DISCOUNT";
const RATE_BASIS_POINTS = 25;
const MIN_RATE_BASIS_POINTS = 1;
const MAX_RATE_BASIS_POINTS = 10_000;
// Shared acceptance fixtures keep this validator aligned with the server.
const UNSUPPORTED_COPY_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;
export const PROTECTION_ATTRIBUTE_KEYS = [
  "_yasas_protection_rule_id",
  "_yasas_protection_rule_version",
  "_yasas_protection_rate_bps",
  "_yasas_protection_basis",
  "_yasas_protection_contract_version",
];
const ALLOWED_DELIVERY_TYPES = new Set(["shipping", "local", "pickupPoint"]);
const ZERO_MINOR_UNIT_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_MINOR_UNIT_CURRENCIES = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);
const FOUR_MINOR_UNIT_CURRENCIES = new Set(["CLF", "UYW"]);

/**
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
 * }} ShippingProtectionConfiguration
 */

/**
 * @typedef {{amount: number, currencyCode: string}} CheckoutMoney
 * @typedef {{
 *   type: string,
 *   code?: string,
 *   title?: string,
 *   discountedAmount: CheckoutMoney
 * }} CheckoutDiscountAllocation
 * @typedef {{
 *   id: string,
 *   quantity: number,
 *   attributes: {key: string, value: string}[],
 *   merchandise: {id: string, requiresShipping: boolean, sellingPlan?: unknown},
 *   cost: {totalAmount: CheckoutMoney},
 *   discountAllocations: CheckoutDiscountAllocation[]
 * }} CheckoutLine
 * @typedef {{
 *   target: {type: string},
 *   metafield: {namespace: string, key: string, value: string}
 * }} CheckoutAppMetafield
 * @typedef {{
 *   groupType: string,
 *   isDeliveryRequired: boolean,
 *   targetedCartLines: {id: string}[],
 *   selectedDeliveryOption?: {handle: string},
 *   deliveryOptions: {handle: string, type: string}[]
 * }} CheckoutDeliveryGroup
 */

/**
 * @param {unknown} value
 * @returns {ShippingProtectionConfiguration | null}
 */
function validateConfiguration(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const invalidCommonFields =
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.productId !== "string" ||
    !candidate.productId.startsWith("gid://shopify/Product/") ||
    typeof candidate.variantId !== "string" ||
    !candidate.variantId.startsWith("gid://shopify/ProductVariant/") ||
    candidate.basis !== CONFIG_BASIS;
  if (invalidCommonFields) {
    return null;
  }

  if (candidate.schemaVersion === 1) {
    if (candidate.rateBasisPoints !== RATE_BASIS_POINTS) return null;
    return /** @type {ShippingProtectionConfiguration} */ (value);
  }

  if (
    candidate.schemaVersion !== 2 ||
    typeof candidate.ruleId !== "string" ||
    candidate.ruleId.length < 1 ||
    !Number.isInteger(candidate.ruleVersion) ||
    Number(candidate.ruleVersion) < 1 ||
    !Number.isInteger(candidate.rateBasisPoints) ||
    Number(candidate.rateBasisPoints) < MIN_RATE_BASIS_POINTS ||
    Number(candidate.rateBasisPoints) > MAX_RATE_BASIS_POINTS ||
    typeof candidate.effectiveAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.effectiveAt))
  ) {
    return null;
  }

  return /** @type {ShippingProtectionConfiguration} */ (value);
}

/** @param {ShippingProtectionConfiguration} configuration */
export function protectionAttributes(configuration) {
  return [
    {
      key: "_yasas_protection_rule_id",
      value: configuration.ruleId ?? "legacy-v1",
    },
    {
      key: "_yasas_protection_rule_version",
      value: String(configuration.ruleVersion ?? 1),
    },
    {
      key: "_yasas_protection_rate_bps",
      value: String(configuration.rateBasisPoints),
    },
    {
      key: "_yasas_protection_basis",
      value: configuration.basis,
    },
    {
      key: "_yasas_protection_contract_version",
      value: String(configuration.schemaVersion),
    },
  ];
}

/**
 * @param {CheckoutLine} line
 * @param {ShippingProtectionConfiguration} configuration
 */
export function protectionAttributesMatch(line, configuration) {
  const values = new Map(
    (line.attributes ?? []).map(({ key, value }) => [key, value]),
  );
  return protectionAttributes(configuration).every(
    ({ key, value }) => values.get(key) === value,
  );
}

/**
 * @param {CheckoutLine} line
 * @param {ShippingProtectionConfiguration} configuration
 */
export function reconciledProtectionAttributes(line, configuration) {
  const managedKeys = new Set(PROTECTION_ATTRIBUTE_KEYS);
  return [
    ...(line.attributes ?? []).filter(({ key }) => !managedKeys.has(key)),
    ...protectionAttributes(configuration),
  ];
}

/**
 * @param {CheckoutAppMetafield[]} appMetafields
 * @returns {ShippingProtectionConfiguration | null}
 */
export function readConfiguration(appMetafields) {
  const entry = appMetafields.find(
    ({ target, metafield }) =>
      target.type === "shop" &&
      metafield.namespace === CONFIG_NAMESPACE &&
      metafield.key === CONFIG_KEY,
  );
  if (!entry) return null;

  try {
    return validateConfiguration(JSON.parse(entry.metafield.value));
  } catch {
    return null;
  }
}

/**
 * @param {string} currencyCode
 */
export function currencyMinorUnits(currencyCode) {
  if (ZERO_MINOR_UNIT_CURRENCIES.has(currencyCode)) return 0;
  if (THREE_MINOR_UNIT_CURRENCIES.has(currencyCode)) return 3;
  if (FOUR_MINOR_UNIT_CURRENCIES.has(currencyCode)) return 4;
  return 2;
}

/**
 * @typedef {{checkboxLabel: string | null, supportingText: string | null}} CheckoutOffer
 * @param {CheckoutAppMetafield[]} appMetafields
 * @returns {CheckoutOffer}
 */
export function readCheckoutOffer(appMetafields) {
  const fallback = {
    checkboxLabel: null,
    supportingText: null,
  };
  const entry = appMetafields.find(
    ({ target, metafield }) =>
      target.type === "shop" &&
      metafield.namespace === CONFIG_NAMESPACE &&
      metafield.key === OFFER_KEY,
  );
  if (!entry) return fallback;
  try {
    const offer = JSON.parse(entry.metafield.value);
    const validCopy = (
      /** @type {unknown} */ value,
      /** @type {number} */ limit,
    ) =>
      value === null ||
      (typeof value === "string" &&
        value.length > 0 &&
        value.length <= limit &&
        !UNSUPPORTED_COPY_CHARACTERS.test(value));
    if (
      offer?.schemaVersion !== 1 ||
      !validCopy(offer.checkboxLabel, 120) ||
      !validCopy(offer.supportingText, 500)
    )
      return fallback;
    return {
      checkboxLabel: offer.checkboxLabel,
      supportingText: offer.supportingText,
    };
  } catch {
    return fallback;
  }
}

/**
 * @param {string[]} amounts
 * @param {number} rateBasisPoints
 * @param {number} minorUnits
 */
export function calculateRoundedFee(amounts, rateBasisPoints, minorUnits) {
  if (
    amounts.length === 0 ||
    !Number.isInteger(rateBasisPoints) ||
    rateBasisPoints < MIN_RATE_BASIS_POINTS ||
    rateBasisPoints > MAX_RATE_BASIS_POINTS ||
    !Number.isInteger(minorUnits) ||
    minorUnits < 0 ||
    minorUnits > 4
  )
    return null;

  /** @type {{whole: string, fraction: string}[]} */
  const parsed = [];
  for (const amount of amounts) {
    if (!/^\d+(?:\.\d+)?$/.test(amount)) return null;
    const [whole, fraction = ""] = amount.split(".");
    parsed.push({ whole, fraction });
  }

  const scaleDigits = Math.max(
    ...parsed.map(({ fraction }) => fraction.length),
  );
  // Shopify CLI's ES6 bundle lowers ** to Math.pow, which rejects BigInt, and
  // warns on BigInt literals. Construct values with BigInt() instead.
  const scale = BigInt("1" + "0".repeat(scaleDigits));
  const two = BigInt(2);
  const subtotal = parsed.reduce((sum, { whole, fraction }) => {
    const paddedFraction = fraction.padEnd(scaleDigits, "0");
    return sum + BigInt(whole) * scale + BigInt(paddedFraction || "0");
  }, BigInt(0));
  const numerator =
    subtotal * BigInt(rateBasisPoints) * BigInt("1" + "0".repeat(minorUnits));
  const denominator = scale * BigInt(10_000);
  const roundedMinor = (numerator * two + denominator) / (denominator * two);
  if (roundedMinor > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  // Convert only the rounded fee. Its decimal representation must retain every
  // minor unit before it can be passed to Shopify's number-based formatter.
  const amount = Number(roundedMinor) / 10 ** minorUnits;
  const [whole, fraction = ""] = String(amount).split(".");
  if (
    !/^\d+$/.test(whole) ||
    fraction.length > minorUnits ||
    BigInt(whole + fraction.padEnd(minorUnits, "0")) !== roundedMinor
  )
    return null;
  return amount;
}

/**
 * Protection is the configured variant only. Line properties are
 * customer-editable, so a merchandise line carrying them stays merchandise.
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 */
export function protectionLines(lines, variantId) {
  return lines.filter((line) => line.merchandise.id === variantId);
}

/**
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 */
export function eligibleMerchandiseLines(lines, variantId) {
  return lines.filter(
    (line) =>
      line.merchandise.id !== variantId &&
      line.merchandise.requiresShipping === true,
  );
}

/**
 * The line's amount before its own discounts. Checkout lists only line-level
 * discounts on a line, but it also takes the line's share of any order-level
 * discount off `totalAmount`, so this is exact only without order discounts.
 * @param {CheckoutLine} line
 * @returns {string[] | null}
 */
function amountsBeforeLineDiscounts(line) {
  const { currencyCode } = line.cost.totalAmount;
  if (
    line.discountAllocations.some(
      ({ discountedAmount }) => discountedAmount.currencyCode !== currencyCode,
    )
  )
    return null;
  return [
    String(line.cost.totalAmount.amount),
    ...line.discountAllocations.map(({ discountedAmount }) =>
      String(discountedAmount.amount),
    ),
  ];
}

/**
 * @param {string} amount a decimal string
 * @param {number} quantity
 */
function multiplyDecimal(amount, quantity) {
  const [whole, fraction = ""] = amount.split(".");
  const digits = (BigInt(whole + fraction) * BigInt(quantity))
    .toString()
    .padStart(fraction.length + 1, "0");
  if (fraction.length === 0) return digits;
  return `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`;
}

/**
 * @typedef {Map<string, {amount: string, currencyCode: string}>} VariantPrices
 * Storefront API unit prices for the buyer's country, keyed by variant ID.
 */

/**
 * Reads a Storefront API `nodes` response into unit prices. Variants the
 * channel cannot see come back as null and are left out.
 * @param {unknown} data
 * @returns {VariantPrices}
 */
export function readVariantPrices(data) {
  /** @type {VariantPrices} */
  const prices = new Map();
  const nodes = /** @type {{nodes?: unknown}} */ (data ?? {}).nodes;
  if (!Array.isArray(nodes)) return prices;
  for (const node of nodes) {
    const id = node?.id;
    const amount = node?.price?.amount;
    const currencyCode = node?.price?.currencyCode;
    if (
      typeof id === "string" &&
      (typeof amount === "string" || typeof amount === "number") &&
      typeof currencyCode === "string"
    )
      prices.set(id, { amount: String(amount), currencyCode });
  }
  return prices;
}

/**
 * The Function prices from each line's pre-discount subtotal. Without an
 * order-level discount that is the line total plus its listed discounts.
 * Checkout does not itemize an order discount's share per line, so with one
 * the subtotal is the Storefront unit price times quantity instead; until
 * those prices are available the quote is "pending".
 * @param {CheckoutLine[]} lines
 * @param {ShippingProtectionConfiguration} configuration
 * @param {CheckoutDiscountAllocation[]} [orderDiscountAllocations] the Discounts API's order-level allocations
 * @param {VariantPrices} [variantPrices]
 * @returns {CheckoutMoney | null | "pending"}
 */
export function reconstructQuote(
  lines,
  configuration,
  orderDiscountAllocations = [],
  variantPrices,
) {
  const eligibleLines = eligibleMerchandiseLines(
    lines,
    configuration.variantId,
  );
  if (eligibleLines.length === 0) return null;

  const currencyCode = eligibleLines[0].cost.totalAmount.currencyCode;
  if (
    eligibleLines.some(
      (line) => line.cost.totalAmount.currencyCode !== currencyCode,
    )
  )
    return null;

  /** @type {string[]} */
  const amounts = [];
  for (const line of eligibleLines) {
    if (orderDiscountAllocations.length === 0) {
      const lineAmounts = amountsBeforeLineDiscounts(line);
      if (!lineAmounts) return null;
      amounts.push(...lineAmounts);
      continue;
    }
    const price = variantPrices?.get(line.merchandise.id);
    if (
      !price ||
      price.currencyCode !== currencyCode ||
      !/^\d+(?:\.\d+)?$/.test(price.amount) ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1
    )
      return "pending";
    amounts.push(multiplyDecimal(price.amount, line.quantity));
  }

  const amount = calculateRoundedFee(
    amounts,
    configuration.rateBasisPoints,
    currencyMinorUnits(currencyCode),
  );
  return amount === null ? null : { amount, currencyCode };
}

/**
 * The protection lines' price before discounts, as the order summary shows
 * it. An order discount takes an unlisted share off the lines, so the price
 * is then known only as a range; the quote is shown when it falls inside it.
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 * @param {CheckoutDiscountAllocation[]} [orderDiscountAllocations]
 * @param {CheckoutMoney | null | "pending"} [quote]
 * @returns {CheckoutMoney | null}
 */
export function actualProtectionTotal(
  lines,
  variantId,
  orderDiscountAllocations = [],
  quote = null,
) {
  const matches = protectionLines(lines, variantId);
  if (matches.length === 0) return null;

  const currencyCode = matches[0].cost.totalAmount.currencyCode;
  /** @type {string[]} */
  const amounts = [];
  for (const line of matches) {
    const lineAmounts = amountsBeforeLineDiscounts(line);
    if (line.cost.totalAmount.currencyCode !== currencyCode || !lineAmounts)
      return null;
    amounts.push(...lineAmounts);
  }
  const minorUnits = currencyMinorUnits(currencyCode);
  // At a 100% rate the fee calculation is an exact decimal sum.
  const total = calculateRoundedFee(amounts, 10_000, minorUnits);
  if (total === null) return null;
  if (orderDiscountAllocations.length === 0)
    return { amount: total, currencyCode };

  if (
    !quote ||
    quote === "pending" ||
    quote.currencyCode !== currencyCode ||
    orderDiscountAllocations.some(
      ({ discountedAmount }) => discountedAmount.currencyCode !== currencyCode,
    )
  )
    return null;
  const maximum = calculateRoundedFee(
    [
      String(total),
      ...orderDiscountAllocations.map(({ discountedAmount }) =>
        String(discountedAmount.amount),
      ),
    ],
    10_000,
    minorUnits,
  );
  return maximum !== null && quote.amount >= total && quote.amount <= maximum
    ? quote
    : null;
}

/**
 * "pending" means checkout hasn't settled on delivery yet: the groups or a
 * selected option are missing while rates load, such as after an address
 * change. That is not a reason to remove protection the buyer chose.
 * @param {CheckoutDeliveryGroup[]} deliveryGroups
 * @param {Set<string>} eligibleLineIds
 * @returns {"eligible" | "ineligible" | "pending"}
 */
export function deliveryEligibility(deliveryGroups, eligibleLineIds) {
  if (eligibleLineIds.size === 0) return "ineligible";
  const relevantGroups = deliveryGroups.filter((group) =>
    group.targetedCartLines.some(({ id }) => eligibleLineIds.has(id)),
  );
  if (relevantGroups.length === 0) return "pending";

  let pending = false;
  for (const group of relevantGroups) {
    if (group.groupType !== "oneTimePurchase" || !group.isDeliveryRequired) {
      return "ineligible";
    }
    const selected = group.deliveryOptions.find(
      ({ handle }) => handle === group.selectedDeliveryOption?.handle,
    );
    if (!selected) {
      pending = true;
    } else if (!ALLOWED_DELIVERY_TYPES.has(selected.type)) {
      return "ineligible";
    }
  }
  return pending ? "pending" : "eligible";
}

/**
 * @param {CheckoutLine[]} lines
 */
export function containsSellingPlan(lines) {
  return lines.some(({ merchandise }) => Boolean(merchandise.sellingPlan));
}
