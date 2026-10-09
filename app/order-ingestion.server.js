import { createHash } from "node:crypto";
import { moneyToScaled, scaledToMoney } from "./order-normalization.js";
import { classifyProtectionRefund } from "./protection-refunds.js";
import { PRICING_SCHEMA_VERSION, calculateFee, currencyMinorUnits } from "./pricing-contract.js";
import { reportFailure } from "./observability.server.js";
import { queueOrderRefresh } from "./webhook-inbox.server.js";
import { isPastRetention } from "./order-retention.js";

// These columns are 32-bit INTEGERs. Line properties are customer-editable, so
// an out-of-range value would fail the order's whole write on every retry.
const MAX_INTEGER_COLUMN = 2_147_483_647;

function boundedInteger(value, min, max = MAX_INTEGER_COLUMN) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function protectionAttribution(line, rules) {
  const attributes = line.protectionAttributes;
  const ruleVersion = Number(attributes._yasas_protection_rule_version);
  const rateBasisPoints = Number(attributes._yasas_protection_rate_bps);
  const pricingContractVersion = Number(attributes._yasas_protection_contract_version);
  const recognizedContract = attributes._yasas_protection_contract_version === undefined ||
    pricingContractVersion === PRICING_SCHEMA_VERSION;
  const rule = recognizedContract ? rules.find(
    (candidate) =>
      candidate.ruleId === attributes._yasas_protection_rule_id &&
      candidate.version === ruleVersion &&
      candidate.rateBasisPoints === rateBasisPoints &&
      candidate.basis === attributes._yasas_protection_basis &&
      candidate.variantId === line.variantId,
  ) : null;
  return {
    rule: rule ?? null,
    ruleId: attributes._yasas_protection_rule_id ?? null,
    ruleVersion: boundedInteger(ruleVersion, 1),
    rateBasisPoints: boundedInteger(rateBasisPoints, 1, 10_000),
    basis: attributes._yasas_protection_basis ?? null,
    pricingContractVersion: boundedInteger(pricingContractVersion, 1),
    status: rule ? "ATTRIBUTED" : "UNATTRIBUTED",
  };
}

// Was the protection line charged what the Cart Transform would charge at the
// attributed rule's rate? The Function prices in the customer's (presentment)
// currency, so compare there when Shopify returned those amounts. A mismatch
// usually means the Function failed and the variant's fallback price applied.
// This compares list unit prices (originalUnitPriceSet), which are before every
// discount: the Cart Transform prices the line before an order-level discount
// takes its share. Never compare `finalAmount` here; that is what the buyer paid
// after all discounts, and is what the recorded fee and covered amounts use.
export function livePriceCheck(normalized, eligibleLines, protectedLines, rule) {
  if (!rule) return { pricingCheck: null, expectedFee: null, chargedFee: null, currencyCode: null };
  const relevant = [...eligibleLines, ...protectedLines];
  const presentment = normalized.presentmentCurrencyCode &&
    relevant.every((line) => line.presentmentUnitAmount != null);
  const unitAmount = (line) => (presentment ? line.presentmentUnitAmount : line.originalUnitAmount);
  const currencyCode = presentment ? normalized.presentmentCurrencyCode : normalized.currencyCode;
  const expectedFee = calculateFee(
    eligibleLines.map((line) => scaledToMoney(moneyToScaled(unitAmount(line)) * BigInt(line.quantity))),
    rule.rateBasisPoints,
    currencyMinorUnits(currencyCode),
  );
  // The Function charges the fee once per order, so compare the total charged.
  const charged = protectedLines.reduce(
    (sum, line) => sum + moneyToScaled(unitAmount(line)) * BigInt(line.quantity), 0n,
  );
  const matched = expectedFee !== null && charged === moneyToScaled(expectedFee);
  // Charged and expected share one basis, so an alert can show them together.
  return { pricingCheck: matched ? "MATCHED" : "UNMATCHED", expectedFee, chargedFee: scaledToMoney(charged), currencyCode };
}

// A line's amounts still include units an order edit deleted, so take the
// surviving units' share of them.
function survivingShare(line, amount) {
  if (line.liveQuantity <= 0 || line.quantity <= 0) return 0n;
  return moneyToScaled(amount) * BigInt(line.liveQuantity) / BigInt(line.quantity);
}

function orderContentHash(normalized) {
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// Runs inside the caller's transaction, which can still roll back or retry, so
// alerts go into afterCommit for the caller to send once it commits.
export async function persistNormalizedOrder(
  transaction,
  shop,
  normalized,
  afterCommit = [],
  { now = new Date() } = {},
) {
  // An order past the retention ceiling is never stored again; a late update
  // would otherwise recreate a record the purge removed. Callers still complete
  // its deliveries.
  if (isPastRetention(normalized.shopifyCreatedAt, now)) return null;
  const rules = await transaction.pricingRule.findMany({
    where: { shopId: shop.id },
  });
  // Protection is identified by the app's own variant, as the Cart Transform
  // does. Line properties are customer-editable, so they only attribute a
  // protection line to its rule; they never make a line protection.
  const protectionVariants = new Set(rules.map(({ variantId }) => variantId));
  // Units an order edit deleted still sit in the line's quantity and amounts, so
  // what protection covers counts only the surviving units. The charge check
  // and the single-unit test stay on the original lines: the Cart Transform
  // priced the cart as it was at checkout.
  const lines = normalized.lines.map((line) => ({
    ...line,
    liveQuantity: line.quantity - (line.removedQuantity ?? 0),
    isProtection: Boolean(line.variantId && protectionVariants.has(line.variantId)),
  }));
  const existing = await transaction.order.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: normalized.shopifyOrderId } },
  });
  if (existing?.shopifyUpdatedAt > normalized.shopifyUpdatedAt) return existing;
  const contentHash = orderContentHash(normalized);
  // Shopify's updatedAt is to the second, so two different copies from the
  // same second can't be ordered. Store this one and refetch the order once
  // both writes have settled; keyed by version, so it is fetched only once.
  if (existing && existing.shopifyUpdatedAt.getTime() === normalized.shopifyUpdatedAt.getTime() &&
    existing.contentHash !== contentHash) {
    await queueOrderRefresh({
      shopId: shop.id, shopifyOrderId: normalized.shopifyOrderId,
      version: normalized.shopifyUpdatedAt.toISOString(), reason: "same-second", database: transaction,
    });
  }
  const eligible = lines.some((line) => !line.isProtection && line.requiresShipping && line.liveQuantity > 0);
  const coveredMerchandise = scaledToMoney(lines
    .filter((line) => !line.isProtection && line.requiresShipping)
    .reduce((sum, line) => sum + survivingShare(line, line.finalAmount), 0n));
  const protectedLines = lines.filter((line) => line.isProtection && line.liveQuantity > 0);
  // Shopify skips the Cart Transform when any line has a selling plan, so the
  // protection line is never charged: a subscription order is not protected.
  // Likewise the Function charges the fee only on a single-unit protection
  // line and prices the rest at zero, so without one nothing was charged.
  const purchasable = protectedLines.length > 0 &&
    protectedLines.some((line) => line.quantity === 1) &&
    !normalized.lines.some((line) => line.hasSellingPlan);
  const firstPayment = Boolean(normalized.paidAt && !existing?.firstPaidAt);
  const paidFacts = firstPayment ? {
    firstPaidAt: normalized.paidAt,
    paidEligible: eligible,
    paidMerchandiseAmount: coveredMerchandise,
  } : {};
  const {
    lines: ignoredLines, refunds: ignoredRefunds, paidAt: ignoredPaidAt,
    presentmentCurrencyCode: ignoredPresentmentCurrency, ...fields
  } = normalized;
  void ignoredLines;
  void ignoredRefunds;
  void ignoredPaidAt;
  void ignoredPresentmentCurrency;

  const order = await transaction.order.upsert({
    where: {
      shopId_shopifyOrderId: {
        shopId: shop.id,
        shopifyOrderId: normalized.shopifyOrderId,
      },
    },
    create: {
      shopId: shop.id,
      ...fields,
      contentHash,
      ...paidFacts,
    },
    update: {
      ...fields,
      contentHash,
    },
  });
  if (firstPayment && existing) {
    await transaction.order.updateMany({
      where: { id: order.id, shopId: shop.id, firstPaidAt: null },
      data: paidFacts,
    });
  }

  await transaction.orderLine.deleteMany({ where: { shopId: shop.id, orderId: order.id } });
  await transaction.orderLine.createMany({
    data: lines.map((line) => ({
      shopId: shop.id,
      orderId: order.id,
      shopifyLineItemId: line.shopifyLineItemId,
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      requiresShipping: line.requiresShipping,
      currencyCode: line.currencyCode,
      originalUnitAmount: line.originalUnitAmount,
      preDiscountAmount: line.preDiscountAmount,
      totalDiscountAmount: line.totalDiscountAmount,
      finalAmount: line.finalAmount,
      isProtection: line.isProtection,
    })),
  });

  const purchaseKey = { orderId: order.id, shopId: shop.id };
  const existingPurchase = await transaction.protectionPurchase.findUnique({
    where: { orderId_shopId: purchaseKey },
  });
  if (existing?.firstPaidAt && existing?.paidProtected && !existingPurchase?.purchasedAt) {
    throw new Error("Paid protection purchase is missing or unconfirmed; reconcile this order before updating it.");
  }
  let confirmedPurchase = existingPurchase?.purchasedAt ? existingPurchase : null;

  if (!confirmedPurchase && (!existing?.firstPaidAt || firstPayment) && purchasable) {
    const attributions = protectedLines.map((line) => protectionAttribution(line, rules));
    const firstAttribution = attributions[0];
    const allMatch = attributions.every((entry) =>
      entry.rule?.id === firstAttribution.rule?.id &&
      entry.ruleId === firstAttribution.ruleId &&
      entry.ruleVersion === firstAttribution.ruleVersion &&
      entry.rateBasisPoints === firstAttribution.rateBasisPoints &&
      entry.basis === firstAttribution.basis &&
      entry.pricingContractVersion === firstAttribution.pricingContractVersion);
    const selected = allMatch ? firstAttribution : {
      ...firstAttribution, rule: null, status: "UNATTRIBUTED",
    };
    const eligibleSubtotal = lines
      .filter((line) => !line.isProtection && line.requiresShipping)
      .reduce((sum, line) => sum + survivingShare(line, line.preDiscountAmount), 0n);
    // The fee actually collected: after every discount, including the share of
    // an order-level discount that checkout allocates to the protection line.
    const fee = protectedLines.reduce((sum, line) => sum + moneyToScaled(line.finalAmount), 0n);
    const { pricingCheck, expectedFee, chargedFee, currencyCode: checkedCurrency } = livePriceCheck(
      normalized,
      lines.filter((line) => !line.isProtection && line.requiresShipping),
      protectedLines,
      selected.rule,
    );
    const purchase = {
      pricingRuleId: selected.rule?.id ?? null,
      ruleId: selected.ruleId,
      ruleVersion: selected.ruleVersion,
      rateBasisPoints: selected.rateBasisPoints,
      basis: selected.basis,
      pricingContractVersion: selected.pricingContractVersion,
      currencyCode: normalized.currencyCode,
      eligibleSubtotalAmount: scaledToMoney(eligibleSubtotal),
      coveredMerchandiseAmount: firstPayment ? coveredMerchandise : null,
      orderValueAmount: firstPayment ? normalized.totalAmount : null,
      feeAmount: scaledToMoney(fee),
      protectionLineIds: protectedLines.map((line) => line.shopifyLineItemId),
      purchasedAt: firstPayment ? normalized.paidAt : null,
      attributionStatus: selected.status,
      pricingCheck,
    };
    confirmedPurchase = await transaction.protectionPurchase.upsert({
      where: { orderId_shopId: purchaseKey },
      create: { ...purchaseKey, ...purchase },
      update: purchase,
    });
    if (firstPayment && pricingCheck === "UNMATCHED") {
      afterCommit.push(() => reportFailure("protection_price_unmatched",
        new Error("Protection was not charged the live price."), {
          shopId: shop.id, shopifyOrderId: normalized.shopifyOrderId,
          chargedFeeAmount: chargedFee, expectedFeeAmount: expectedFee, currencyCode: checkedCurrency,
        }));
    }
  } else if (!confirmedPurchase && (!purchasable || existing?.firstPaidAt)) {
    await transaction.protectionPurchase.deleteMany({
      where: { ...purchaseKey, purchasedAt: null },
    });
  }

  const paidPurchase = confirmedPurchase?.purchasedAt ? confirmedPurchase : null;
  const cache = paidPurchase
    ? { paidProtected: true, paidProtectionFee: paidPurchase.feeAmount,
      paidProtectionLineIds: paidPurchase.protectionLineIds }
    : { paidProtected: false, paidProtectionFee: "0.0000", paidProtectionLineIds: [] };
  const synchronizedOrder = await transaction.order.update({
    where: { id_shopId: { id: order.id, shopId: shop.id } },
    data: cache,
  });
  await persistOrderRefunds(transaction, shop, synchronizedOrder, normalized, lines, paidPurchase);
  return synchronizedOrder;
}

async function persistOrderRefunds(transaction, shop, order, normalized, lines, paidPurchase) {
  if (!normalized.refunds) return;
  const protectionLineIds = paidPurchase?.protectionLineIds ?? [];
  const currencyCode = paidPurchase?.currencyCode ?? normalized.currencyCode;
  const knownLineIds = [...new Set([...lines.map((line) => line.shopifyLineItemId), ...protectionLineIds])];
  const ignoredRefundIds = [];
  for (const refund of normalized.refunds) {
    const result = classifyProtectionRefund(refund, {
      currencyCode,
      protectionLineIds,
      knownLineIds,
      protectedOrder: Boolean(paidPurchase),
    });
    if (result.status === "IGNORED") {
      ignoredRefundIds.push(refund.id);
      continue;
    }
    await transaction.protectionRefund.upsert({
      where: { shopId_shopifyRefundId: { shopId: shop.id, shopifyRefundId: refund.id } },
      create: { shopId: shop.id, orderId: order.id, shopifyRefundId: refund.id,
        status: result.status, amount: result.amount, currencyCode, succeededAt: result.succeededAt },
      update: { status: result.status, amount: result.amount, currencyCode, succeededAt: result.succeededAt },
    });
  }
  // A refund stored while its money was still moving can turn out to owe nothing
  // (for example, its transaction failed). Mark that row IGNORED so it leaves the
  // recheck queue and the totals but stays on record; a settled (CONFIRMED)
  // refund is never changed. Only a protected order has stored refunds.
  if (paidPurchase && ignoredRefundIds.length > 0) {
    await transaction.protectionRefund.updateMany({
      where: { shopId: shop.id, orderId: order.id, shopifyRefundId: { in: ignoredRefundIds },
        status: { in: ["PENDING", "UNATTRIBUTED"] } },
      data: { status: "IGNORED", succeededAt: null },
    });
  }
}
