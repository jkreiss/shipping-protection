import { moneyToScaled, scaledToMoney } from "../order-normalization.js";
import { currencyMinorUnits, formatBasisPoints } from "../pricing-contract.js";

// Revenue-share ledger rules. Money is scaled bigint (four decimals), the same
// representation order ingestion uses. Only paid protection purchases and
// confirmed protection refunds, both ingested from Shopify orders, are billed.

/** @param {string | number | { toFixed(digits: number): string }} value */
function toScaled(value) {
  return moneyToScaled(typeof value === "object" && value !== null ? value.toFixed(4) : String(value));
}

function billable(agreement) {
  return agreement.status === "ACTIVE" && agreement.mode !== "FREE" && Boolean(agreement.activatedAt);
}

// A paid, non-test purchase in the agreement's currency, paid on or after the
// merchant approved billing, contributes its fee. Nothing earlier is billed.
export function purchaseTarget(purchase, agreement) {
  if (!billable(agreement) || purchase.isTest || purchase.currencyCode !== agreement.currencyCode) return 0n;
  if (!purchase.purchasedAt || purchase.purchasedAt < agreement.activatedAt) return 0n;
  return toScaled(purchase.feeAmount);
}

// Callers pass only refunds of purchases already billed under this agreement.
// A net share subtracts each confirmed refund; a refund that is no longer
// confirmed contributes nothing, so its earlier entry is reversed.
export function refundTarget(refund, agreement) {
  if (!billable(agreement) || agreement.mode !== "NET_SHARE") return 0n;
  if (refund.isTest || refund.currencyCode !== agreement.currencyCode || refund.status !== "CONFIRMED") return 0n;
  return -toScaled(refund.amount);
}

// Entries to append so each source's entries sum to what it should contribute.
// `entered` is the sum already entered under this agreement and `lastRevision`
// the source's highest revision under any agreement (-1 for none).
export function planEntries(sources, agreement) {
  if (!billable(agreement)) return [];
  const planned = [];
  for (const source of sources) {
    const target = source.sourceType === "PURCHASE"
      ? purchaseTarget(source, agreement)
      : refundTarget(source, agreement);
    const delta = target - toScaled(source.entered);
    if (delta === 0n) continue;
    planned.push({
      sourceType: source.sourceType, sourceId: source.sourceId, revision: source.lastRevision + 1,
      amount: scaledToMoney(delta), currencyCode: agreement.currencyCode,
    });
  }
  return planned;
}

// The usage charge for a set of unassigned entries: the agreement's rate on
// their sum, floored to the currency's minor units. A sum at or below zero,
// or a charge that floors to nothing, creates no charge; the entries stay
// unassigned and carry forward to offset or join later revenue.
export function planCharge(amounts, agreement) {
  if (!billable(agreement)) return null;
  const base = amounts.reduce((sum, amount) => sum + toScaled(amount), 0n);
  if (base <= 0n) return null;
  const unit = 10n ** BigInt(4 - currencyMinorUnits(agreement.currencyCode));
  const charge = (base * BigInt(agreement.rateBasisPoints) / 10_000n) / unit * unit;
  if (charge <= 0n) return null;
  return { baseAmount: scaledToMoney(base), chargeAmount: scaledToMoney(charge) };
}

// Merchant-facing terms: neutral and factual, shown on Shopify's approval page,
// in Settings and on each usage charge.
export function describeRevenueShare(agreement) {
  if (agreement.mode === "FREE") return "No charge";
  const share = `${formatBasisPoints(agreement.rateBasisPoints)} of protection revenue`;
  return agreement.mode === "NET_SHARE" ? `${share}, net of protection refunds` : share;
}

// An amount for display, in the currency's minor units (fees and charges are
// already whole minor units, so nothing is rounded away).
export function formatAmount(value, currencyCode) {
  const [whole, fraction = ""] = (typeof value === "object" && value !== null ? value.toFixed(4) : String(value)).split(".");
  const digits = currencyMinorUnits(currencyCode);
  return digits ? `${whole}.${fraction.padEnd(digits, "0").slice(0, digits)}` : whole;
}
