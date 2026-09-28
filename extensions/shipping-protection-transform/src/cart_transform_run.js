// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

const CONFIG_BASIS = "SHIPPABLE_PRE_DISCOUNT";
const RATE_BASIS_POINTS = 25;
const MIN_RATE_BASIS_POINTS = 1;
const MAX_RATE_BASIS_POINTS = 10_000;
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
 * @param {unknown} value
 */
function parseConfiguration(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (
    candidate.enabled !== true ||
    typeof candidate.productId !== "string" ||
    !candidate.productId.startsWith("gid://shopify/Product/") ||
    typeof candidate.variantId !== "string" ||
    !candidate.variantId.startsWith("gid://shopify/ProductVariant/") ||
    candidate.basis !== CONFIG_BASIS
  ) {
    return null;
  }

  if (candidate.schemaVersion === 1) {
    if (candidate.rateBasisPoints !== RATE_BASIS_POINTS) return null;
  } else if (
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

  return {
    variantId: candidate.variantId,
    rateBasisPoints: Number(candidate.rateBasisPoints),
  };
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

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const configuration = parseConfiguration(
    input.cartTransform?.configuration?.jsonValue,
  );
  if (!configuration) return NO_CHANGES;
  if (input.cart.lines.some((line) => line.sellingPlanAllocation)) {
    return NO_CHANGES;
  }

  const protectionLines = input.cart.lines
    .filter(
      (line) =>
        line.merchandise.__typename === "ProductVariant" &&
        line.merchandise.id === configuration.variantId,
    )
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  if (protectionLines.length === 0) return NO_CHANGES;

  const eligibleLines = input.cart.lines.filter((line) => {
    if (
      line.merchandise.__typename === "ProductVariant" &&
      line.merchandise.id === configuration.variantId
    ) {
      return false;
    }
    return line.merchandise.requiresShipping === true;
  });
  if (eligibleLines.length === 0) return NO_CHANGES;

  const currencyCode = eligibleLines[0].cost.subtotalAmount.currencyCode;
  if (
    eligibleLines.some(
      (line) => line.cost.subtotalAmount.currencyCode !== currencyCode,
    )
  ) {
    return NO_CHANGES;
  }

  const amount = calculateFee(
    eligibleLines.map((line) => line.cost.subtotalAmount.amount),
    configuration.rateBasisPoints,
    currencyMinorUnits(currencyCode),
  );
  if (amount === null) return NO_CHANGES;

  return {
    operations: protectionLines.map((line) => ({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: { amount },
          },
        },
      },
    })),
  };
}
