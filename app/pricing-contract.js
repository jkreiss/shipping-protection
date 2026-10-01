import { UserFacingError } from "./user-facing-error.js";

export const PRICING_SCHEMA_VERSION = 2;
export const LEGACY_SCHEMA_VERSION = 1;
export const DEFAULT_RATE_BASIS_POINTS = 25;
export const MIN_RATE_BASIS_POINTS = 1;
export const MAX_RATE_BASIS_POINTS = 10_000;
export const PRICING_BASIS = "SHIPPABLE_PRE_DISCOUNT";

function isProductGid(value) {
  return (
    typeof value === "string" && value.startsWith("gid://shopify/Product/")
  );
}

function isVariantGid(value) {
  return (
    typeof value === "string" &&
    value.startsWith("gid://shopify/ProductVariant/")
  );
}

export function validateRateBasisPoints(value) {
  if (
    !Number.isInteger(value) ||
    value < MIN_RATE_BASIS_POINTS ||
    value > MAX_RATE_BASIS_POINTS
  ) {
    throw new RangeError(
      `Rate must be an integer from ${MIN_RATE_BASIS_POINTS} to ${MAX_RATE_BASIS_POINTS} basis points.`,
    );
  }
  return value;
}

export function parsePricingContract(value) {
  if (!value || typeof value !== "object") return null;

  if (
    value.schemaVersion === LEGACY_SCHEMA_VERSION &&
    typeof value.enabled === "boolean" &&
    isProductGid(value.productId) &&
    isVariantGid(value.variantId) &&
    value.rateBasisPoints === DEFAULT_RATE_BASIS_POINTS &&
    value.basis === PRICING_BASIS
  ) {
    return {
      schemaVersion: LEGACY_SCHEMA_VERSION,
      enabled: value.enabled,
      productId: value.productId,
      variantId: value.variantId,
      rateBasisPoints: DEFAULT_RATE_BASIS_POINTS,
      basis: PRICING_BASIS,
    };
  }

  if (
    value.schemaVersion !== PRICING_SCHEMA_VERSION ||
    typeof value.enabled !== "boolean" ||
    !isProductGid(value.productId) ||
    !isVariantGid(value.variantId) ||
    typeof value.ruleId !== "string" ||
    value.ruleId.length < 1 ||
    !Number.isInteger(value.ruleVersion) ||
    value.ruleVersion < 1 ||
    !Number.isInteger(value.rateBasisPoints) ||
    value.rateBasisPoints < MIN_RATE_BASIS_POINTS ||
    value.rateBasisPoints > MAX_RATE_BASIS_POINTS ||
    value.basis !== PRICING_BASIS ||
    typeof value.effectiveAt !== "string" ||
    !Number.isFinite(Date.parse(value.effectiveAt))
  ) {
    return null;
  }

  return {
    schemaVersion: PRICING_SCHEMA_VERSION,
    enabled: value.enabled,
    productId: value.productId,
    variantId: value.variantId,
    ruleId: value.ruleId,
    ruleVersion: value.ruleVersion,
    rateBasisPoints: value.rateBasisPoints,
    basis: PRICING_BASIS,
    effectiveAt: new Date(value.effectiveAt).toISOString(),
  };
}

export function pricingContractForRule(rule, productId, variantId, enabled = true) {
  validateRateBasisPoints(rule.rateBasisPoints);
  const contract = {
    schemaVersion: PRICING_SCHEMA_VERSION,
    enabled,
    productId,
    variantId,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    rateBasisPoints: rule.rateBasisPoints,
    basis: PRICING_BASIS,
    effectiveAt: new Date(rule.effectiveAt).toISOString(),
  };

  if (!parsePricingContract(contract)) {
    throw new Error("Could not create a valid pricing configuration.");
  }
  return contract;
}

export function formatBasisPoints(rateBasisPoints) {
  validateRateBasisPoints(rateBasisPoints);
  return `${(rateBasisPoints / 100).toLocaleString("en", {
    maximumFractionDigits: 2,
  })}%`;
}

// Merchants enter rates as plain percentages ("1" means 1%); storage and the
// Cart Transform Function keep whole basis points so fees stay integer-exact.
export function percentToBasisPoints(value) {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  const basisPoints = match
    ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
    : Number.NaN;
  if (
    !Number.isSafeInteger(basisPoints) ||
    basisPoints < MIN_RATE_BASIS_POINTS ||
    basisPoints > MAX_RATE_BASIS_POINTS
  ) {
    throw new UserFacingError(
      "Enter a rate from 0.01 to 100, with at most two decimal places. For example, 1 means 1%.",
    );
  }
  return basisPoints;
}

export function basisPointsToPercent(rateBasisPoints) {
  validateRateBasisPoints(rateBasisPoints);
  return String(rateBasisPoints / 100);
}

// Server copy of the Cart Transform's fee calculation, used to check that a
// paid order was charged the live price. Extensions can't import app code;
// test-fixtures/pricing-fees.json keeps the copies identical.
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
export function calculateFee(amounts, rateBasisPoints, minorUnits) {
  if (
    amounts.length === 0 ||
    !Number.isInteger(rateBasisPoints) ||
    rateBasisPoints < MIN_RATE_BASIS_POINTS ||
    rateBasisPoints > MAX_RATE_BASIS_POINTS ||
    !Number.isInteger(minorUnits) ||
    minorUnits < 0
  ) {
    return null;
  }

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
  const scale = 10n ** BigInt(scaleDigits);
  const subtotal = parsed.reduce((sum, { whole, fraction }) => {
    const paddedFraction = fraction.padEnd(scaleDigits, "0");
    return sum + BigInt(whole) * scale + BigInt(paddedFraction || "0");
  }, 0n);
  const numerator =
    subtotal * BigInt(rateBasisPoints) * 10n ** BigInt(minorUnits);
  const denominator = scale * 10_000n;
  const roundedMinor = (numerator * 2n + denominator) / (denominator * 2n);

  if (minorUnits === 0) return roundedMinor.toString();

  const divisor = 10n ** BigInt(minorUnits);
  const whole = roundedMinor / divisor;
  const fraction = (roundedMinor % divisor)
    .toString()
    .padStart(minorUnits, "0");
  return `${whole}.${fraction}`;
}
