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
