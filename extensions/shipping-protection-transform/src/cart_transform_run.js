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
    typeof candidate.enabled !== "boolean" ||
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
    enabled: candidate.enabled,
    variantId: candidate.variantId,
    rateBasisPoints: Number(candidate.rateBasisPoints),
  };
}

/**
 * The fee is charged once per cart, on the first single-unit protection line;
 * every other protection line is set to zero. A Function can't change a
 * quantity and one unit price applies to every unit, so without a single-unit
 * line the fee can't be charged exactly: protection is priced at zero and
 * order ingestion records the order as not protected (decided 2026-10-08).
 * The checkout block resets the quantity to one, so this only happens through
 * paths that skip the block.
 * @param {{ id: string, quantity: number }[]} lines
 * @param {string} amount
 * @returns {CartTransformRunResult}
 */
function priceLines(lines, amount) {
  const charged = lines.find((line) => line.quantity === 1);
  return {
    operations: lines.map((line) => ({
      lineUpdate: {
        cartLineId: line.id,
        price: {
          adjustment: {
            fixedPricePerUnit: { amount: line === charged ? amount : "0" },
          },
        },
      },
    })),
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

  const isProtectionLine = (
    /** @type {CartTransformRunInput["cart"]["lines"][number]} */ line,
  ) =>
    line.merchandise.__typename === "ProductVariant" &&
    line.merchandise.id === configuration.variantId;
  const protectionLines = input.cart.lines
    .filter(isProtectionLine)
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  if (protectionLines.length === 0) return NO_CHANGES;
  // The protection variant is priced at the fallback charged if this Function
  // fails, so a line that shouldn't be charged is set to zero explicitly.
  if (!configuration.enabled) return priceLines(protectionLines, "0");

  const eligibleLines = input.cart.lines.filter(
    (line) =>
      !isProtectionLine(line) && line.merchandise.requiresShipping === true,
  );
  if (eligibleLines.length === 0) return priceLines(protectionLines, "0");

  const currencyCode = eligibleLines[0].cost.subtotalAmount.currencyCode;
  if (
    eligibleLines.some(
      (line) => line.cost.subtotalAmount.currencyCode !== currencyCode,
    )
  ) {
    return priceLines(protectionLines, "0");
  }

  const amount = calculateFee(
    eligibleLines.map((line) => line.cost.subtotalAmount.amount),
    configuration.rateBasisPoints,
    currencyMinorUnits(currencyCode),
  );
  return priceLines(protectionLines, amount ?? "0");
}
