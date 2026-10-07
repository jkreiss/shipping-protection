import prisma from "../db.server.js";
import { logEvent, reportCondition, reportFailure } from "../observability.server.js";
import { moneyToScaled } from "../order-normalization.js";
import { formatBasisPoints } from "../pricing-contract.js";
import { formatAmount } from "./ledger.js";
import { createUsageRecord, readSubscription as readShopifySubscription } from "../shopify/billing-admin.server.js";

// About a day and a half of retries before a charge needs the operator.
export const MAX_CHARGE_ATTEMPTS = 10;
const BATCH = 50;
const INACTIVE_SUBSCRIPTION = new Set(["CANCELLED", "DECLINED", "EXPIRED"]);

export function chargeRetryDelayMs(attempts) {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

const money = (value) => (typeof value === "object" && value !== null ? value.toFixed(4) : String(value));

// Shown on the merchant's Shopify invoice.
function usageDescription(charge, agreement) {
  const base = `${charge.currencyCode} ${formatAmount(charge.baseAmount, charge.currencyCode)}`;
  const share = `${formatBasisPoints(agreement.rateBasisPoints)} of ${base}`;
  return `Shipping protection revenue share: ${share}${agreement.mode === "NET_SHARE" ? ", net of protection refunds" : ""}`;
}

async function update(database, charge, data) {
  await database.billingCharge.updateMany({
    where: { id: charge.id, shopId: charge.shopId, status: { in: ["PENDING", "CAP_EXCEEDED"] } },
    data,
  });
}

async function retryLater(database, charge, now, code, error = new Error(code)) {
  const attempts = charge.attempts + 1;
  await update(database, charge, {
    attempts, errorMessage: code, nextAttemptAt: new Date(now.getTime() + chargeRetryDelayMs(attempts)),
  });
  if (attempts >= MAX_CHARGE_ATTEMPTS) {
    reportFailure("billing_charge_stuck", error, { chargeId: charge.id, shopId: charge.shopId, code });
  }
}

// Shopify's usage-record refusals carry no codes, so the subscription is read
// to tell a cap overrun from an ended subscription.
async function classifyRefusal({ database, charge, agreement, admin, now, readSubscription }) {
  const subscription = await readSubscription(admin, agreement.shop.shopDomain, agreement.subscriptionGid);
  if (!subscription || INACTIVE_SUBSCRIPTION.has(subscription.status)) {
    await update(database, charge, { status: "VOID", errorMessage: "SUBSCRIPTION_INACTIVE" });
    await database.billingAgreement.updateMany({
      where: { id: agreement.id, shopId: agreement.shopId, status: "ACTIVE" },
      data: { status: "CANCELLED", endedAt: now },
    });
    reportCondition("billing_subscription_inactive", { shopId: charge.shopId, chargeId: charge.id, agreementId: agreement.id });
    return;
  }
  const usage = subscription.usageLineItem;
  if (subscription.status === "ACTIVE" && usage &&
    moneyToScaled(usage.balanceUsed) + moneyToScaled(money(charge.chargeAmount)) > moneyToScaled(usage.cappedAmount)) {
    await update(database, charge, {
      status: "CAP_EXCEEDED", errorMessage: "CAP_EXCEEDED",
      // The cap resets with the next billing cycle; a raised cap retries sooner.
      nextAttemptAt: subscription.currentPeriodEnd ?? new Date(now.getTime() + 24 * 60 * 60_000),
    });
    reportCondition("billing_cap_exceeded", { shopId: charge.shopId, chargeId: charge.id, agreementId: agreement.id });
    return;
  }
  // FROZEN (the store's Shopify bill is unpaid) or an unexplained refusal.
  await retryLater(database, charge, now, subscription.status === "ACTIVE" ? "USAGE_RECORD_REJECTED" : `SUBSCRIPTION_${subscription.status}`);
}

async function submitCharge({ database, charge, adminForShop, now, createRecord, readSubscription }) {
  const { agreement } = charge;
  if (agreement.status !== "ACTIVE" || !agreement.usageLineItemGid) {
    await update(database, charge, { status: "VOID", errorMessage: "AGREEMENT_ENDED" });
    return "void";
  }
  if (agreement.shop.installationState !== "INSTALLED") {
    // Uninstalling cancels the subscription, so this charge can never be billed.
    await update(database, charge, { status: "VOID", errorMessage: "SHOP_UNINSTALLED" });
    return "void";
  }
  try {
    const { admin } = await adminForShop(agreement.shop.shopDomain);
    const result = await createRecord(admin, agreement.shop.shopDomain, {
      lineItemId: agreement.usageLineItemGid, amount: money(charge.chargeAmount), currencyCode: charge.currencyCode,
      description: usageDescription(charge, agreement), idempotencyKey: charge.id,
    });
    if (result.usageRecordGid) {
      await update(database, charge, { status: "BILLED", usageRecordGid: result.usageRecordGid, billedAt: now, errorMessage: null });
      logEvent("billing_charge_billed", { shopId: charge.shopId, chargeId: charge.id });
      return "billed";
    }
    if (result.errors.some((message) => /in progress/i.test(message))) {
      await retryLater(database, charge, now, "REQUEST_IN_PROGRESS");
      return "retry";
    }
    await classifyRefusal({ database, charge, agreement, admin, now, readSubscription });
    return "refused";
  } catch (error) {
    await retryLater(database, charge, now, "SUBMIT_FAILED", error);
    return "retry";
  }
}

// Sends each due charge to Shopify. Retries reuse the charge ID as the usage
// record's idempotency key, so Shopify bills a charge at most once.
export async function submitPendingCharges({
  database = prisma, adminForShop, now = new Date(), agreementId,
  createRecord = createUsageRecord, readSubscription = readShopifySubscription,
}) {
  const charges = await database.billingCharge.findMany({
    where: {
      status: { in: ["PENDING", "CAP_EXCEEDED"] }, nextAttemptAt: { lte: now },
      attempts: { lt: MAX_CHARGE_ATTEMPTS }, ...(agreementId ? { agreementId } : {}),
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: BATCH,
    include: { agreement: { include: { shop: { select: { shopDomain: true, installationState: true } } } } },
  });
  const outcomes = { billed: 0, retry: 0, refused: 0, void: 0 };
  for (const charge of charges) {
    outcomes[await submitCharge({ database, charge, adminForShop, now, createRecord, readSubscription })] += 1;
  }
  return outcomes;
}
