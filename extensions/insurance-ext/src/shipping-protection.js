const CONFIG_NAMESPACE = "$app";
const CONFIG_KEY = "shipping_protection_config";
const CONFIG_BASIS = "SHIPPABLE_PRE_DISCOUNT";
const RATE_BASIS_POINTS = 25;
const MIN_RATE_BASIS_POINTS = 1;
const MAX_RATE_BASIS_POINTS = 10_000;
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
 * @typedef {{discountedAmount: CheckoutMoney}} CheckoutDiscountAllocation
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
  const commonValid =
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.productId !== "string" ||
    !candidate.productId.startsWith("gid://shopify/Product/") ||
    typeof candidate.variantId !== "string" ||
    !candidate.variantId.startsWith("gid://shopify/ProductVariant/") ||
    candidate.basis !== CONFIG_BASIS;
  if (commonValid) {
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

/** @param {CheckoutLine} line */
export function hasProtectionProvenance(line) {
  return (line.attributes ?? []).some(({ key }) =>
    PROTECTION_ATTRIBUTE_KEYS.includes(key),
  );
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
 * @param {string[]} amounts
 * @param {number} rateBasisPoints
 * @param {number} minorUnits
 */
export function calculateRoundedFee(amounts, rateBasisPoints, minorUnits) {
  if (amounts.length === 0) return null;

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
  const scale = 10 ** scaleDigits;
  const subtotal = parsed.reduce((sum, { whole, fraction }) => {
    const paddedFraction = fraction.padEnd(scaleDigits, "0");
    return sum + Number(whole) * scale + Number(paddedFraction || "0");
  }, 0);
  const numerator = subtotal * rateBasisPoints * 10 ** minorUnits;
  const denominator = scale * 10_000;
  if (
    !Number.isSafeInteger(subtotal) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator)
  ) {
    return null;
  }
  const roundedMinor = Math.floor((numerator + denominator / 2) / denominator);

  return Number(roundedMinor) / 10 ** minorUnits;
}

/**
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 */
export function protectionLines(lines, variantId) {
  return lines.filter(
    (line) =>
      line.merchandise.id === variantId || hasProtectionProvenance(line),
  );
}

/**
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 */
export function eligibleMerchandiseLines(lines, variantId) {
  return lines.filter(
    (line) =>
      line.merchandise.id !== variantId &&
      !hasProtectionProvenance(line) &&
      line.merchandise.requiresShipping === true,
  );
}

/**
 * @param {CheckoutLine[]} lines
 * @param {ShippingProtectionConfiguration} configuration
 */
export function reconstructQuote(lines, configuration) {
  const eligibleLines = eligibleMerchandiseLines(
    lines,
    configuration.variantId,
  );
  if (eligibleLines.length === 0) return null;

  const currencyCode = eligibleLines[0].cost.totalAmount.currencyCode;
  /** @type {string[]} */
  const amounts = [];

  for (const line of eligibleLines) {
    if (line.cost.totalAmount.currencyCode !== currencyCode) return null;
    amounts.push(String(line.cost.totalAmount.amount));

    for (const allocation of line.discountAllocations) {
      if (allocation.discountedAmount.currencyCode !== currencyCode)
        return null;
      amounts.push(String(allocation.discountedAmount.amount));
    }
  }

  const amount = calculateRoundedFee(
    amounts,
    configuration.rateBasisPoints,
    currencyMinorUnits(currencyCode),
  );
  return amount === null ? null : { amount, currencyCode };
}

/**
 * @param {CheckoutLine[]} lines
 * @param {string} variantId
 */
export function actualProtectionTotal(lines, variantId) {
  const matches = protectionLines(lines, variantId);
  if (matches.length === 0) return null;

  const currencyCode = matches[0].cost.totalAmount.currencyCode;
  if (
    matches.some((line) => line.cost.totalAmount.currencyCode !== currencyCode)
  ) {
    return null;
  }

  return {
    amount: matches.reduce(
      (sum, line) => sum + line.cost.totalAmount.amount,
      0,
    ),
    currencyCode,
  };
}

/**
 * @param {CheckoutDeliveryGroup[]} deliveryGroups
 * @param {Set<string>} eligibleLineIds
 */
export function hasEligibleDelivery(deliveryGroups, eligibleLineIds) {
  const relevantGroups = deliveryGroups.filter((group) =>
    group.targetedCartLines.some(({ id }) => eligibleLineIds.has(id)),
  );
  if (relevantGroups.length === 0) return false;

  return relevantGroups.every((group) => {
    if (group.groupType !== "oneTimePurchase" || !group.isDeliveryRequired) {
      return false;
    }
    const selected = group.deliveryOptions.find(
      ({ handle }) => handle === group.selectedDeliveryOption?.handle,
    );
    return Boolean(selected && ALLOWED_DELIVERY_TYPES.has(selected.type));
  });
}

/**
 * @param {CheckoutLine[]} lines
 */
export function containsSellingPlan(lines) {
  return lines.some(({ merchandise }) => Boolean(merchandise.sellingPlan));
}
