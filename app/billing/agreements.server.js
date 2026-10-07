import prisma from "../db.server.js";
import { logEvent, reportCondition } from "../observability.server.js";
import { moneyToScaled, scaledToMoney } from "../order-normalization.js";
import { percentToBasisPoints } from "../pricing-contract.js";
import { isShopDomain, withShopSettingsLock } from "../shop.server.js";
import {
  cancelSubscription,
  createUsageSubscription,
  readActiveSubscriptions,
  readBillingPreferences,
  readSubscription,
  updateUsageCap,
} from "../shopify/billing-admin.server.js";
import { UserFacingError } from "../user-facing-error.js";
import { describeRevenueShare, formatAmount } from "./ledger.js";
import { createBillingCharge, recordBillingEntries } from "./ledger.server.js";
import { submitPendingCharges } from "./usage-charges.server.js";

// Revenue-share agreements. Only the operator sets terms (scripts/set-billing.js);
// the merchant approves them in Settings, on Shopify's approval page.

const OPEN = ["PENDING_APPROVAL", "ACTIVE"];
const SUBSCRIPTION_PREFIX = "Shipping protection revenue share";
const ENDED_SUBSCRIPTION = new Set(["CANCELLED", "DECLINED", "EXPIRED"]);
const MODES = { free: "FREE", gross: "GROSS_SHARE", net: "NET_SHARE" };
const USAGE = "Usage: npm run merchant:billing -- store.myshopify.com free | gross <percent> <cap> | net <percent> <cap>";

const money = (value) => (value === null || value === undefined ? null
  : scaledToMoney(moneyToScaled(typeof value === "object" ? value.toFixed(4) : String(value))));

// The name merchants see on the subscription. The version ties a Shopify
// subscription back to the terms it was created for.
export function subscriptionName(version) {
  return `${SUBSCRIPTION_PREFIX} (terms ${version})`;
}

/** @param {string[]} args mode, then percent and monthly cap for a paid mode */
export function parseBillingTerms(args) {
  const [modeName, percent, cap, ...extra] = args;
  const mode = MODES[modeName];
  if (!mode || extra.length || (mode === "FREE" ? percent !== undefined : cap === undefined)) {
    throw new UserFacingError(USAGE);
  }
  if (mode === "FREE") return { mode, rateBasisPoints: 0, cappedAmount: null };
  if (!/^\d+(?:\.\d{1,2})?$/.test(cap) || moneyToScaled(cap) <= 0n) {
    throw new UserFacingError("Enter the monthly cap as a positive amount with at most two decimal places.");
  }
  return { mode, rateBasisPoints: percentToBasisPoints(percent), cappedAmount: money(cap) };
}

function sameTerms(agreement, terms, currencyCode) {
  return agreement.mode === terms.mode && agreement.rateBasisPoints === terms.rateBasisPoints &&
    money(agreement.cappedAmount) === terms.cappedAmount &&
    (terms.mode === "FREE" || agreement.currencyCode === currencyCode);
}

async function installedShop(database, shopDomain) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop || shop.installationState !== "INSTALLED") {
    throw new UserFacingError("Choose an installed store before changing billing.");
  }
  return shop;
}

function openAgreement(database, shopId) {
  return database.billingAgreement.findFirst({ where: { shopId, status: { in: OPEN } } });
}

// Bills what the agreement has earned so far, before its subscription is
// cancelled: Shopify accepts no usage charges after that.
export async function settleAgreement({ database = prisma, agreement, adminForShop, now = new Date() }) {
  await recordBillingEntries({ database, agreement });
  await createBillingCharge({ database, agreement, now, final: true });
  await database.billingCharge.updateMany({
    where: { shopId: agreement.shopId, agreementId: agreement.id, status: "PENDING" },
    data: { nextAttemptAt: now },
  });
  const outcome = await submitPendingCharges({ database, adminForShop, now, agreementId: agreement.id });
  const unbilled = await database.billingCharge.count({
    where: { shopId: agreement.shopId, agreementId: agreement.id, status: { in: ["PENDING", "CAP_EXCEEDED"] } },
  });
  return { billed: outcome.billed, unbilled };
}

async function cancelIfActive(admin, shopDomain, subscriptionGid) {
  try {
    await cancelSubscription(admin, shopDomain, subscriptionGid);
  } catch (error) {
    // Already ended on Shopify's side (for example, cancelled by the merchant).
    const subscription = await readSubscription(admin, shopDomain, subscriptionGid);
    if (subscription?.status === "ACTIVE") throw error;
  }
}

// Operator-only: do not expose this through merchant settings actions.
export async function setBillingTerms({
  shopDomain, terms, adminForShop, database = prisma, now = new Date(), settle = settleAgreement,
}) {
  if (!isShopDomain(shopDomain)) throw new UserFacingError(USAGE);
  const shop = await installedShop(database, shopDomain);
  return withShopSettingsLock(shopDomain, async () => {
    const open = await openAgreement(database, shop.id);
    if (!open && terms.mode === "FREE") return { outcome: "unchanged", agreement: null };

    let currencyCode = null;
    if (terms.mode !== "FREE") {
      const { admin } = await adminForShop(shopDomain);
      const preferences = await readBillingPreferences(admin, shopDomain);
      if (preferences.shopCurrency !== preferences.billingCurrency) {
        throw new UserFacingError(`${shopDomain} sells in ${preferences.shopCurrency} but is billed in ` +
          `${preferences.billingCurrency}. Revenue-share billing needs them to match.`);
      }
      currencyCode = preferences.billingCurrency;
    }
    if (open && sameTerms(open, terms, currencyCode)) return { outcome: "unchanged", agreement: open };

    // A higher cap on the same active terms keeps the subscription; the
    // merchant approves the new cap in Settings.
    if (open?.status === "ACTIVE" && open.mode === terms.mode && open.rateBasisPoints === terms.rateBasisPoints &&
      open.currencyCode === currencyCode && moneyToScaled(terms.cappedAmount) > moneyToScaled(money(open.cappedAmount))) {
      await database.billingAgreement.updateMany({
        where: { id: open.id, shopId: shop.id, status: "ACTIVE" }, data: { pendingCappedAmount: terms.cappedAmount },
      });
      return { outcome: "cap-requested", agreement: { ...open, pendingCappedAmount: terms.cappedAmount } };
    }

    let settlement = null;
    if (open?.status === "ACTIVE" && open.subscriptionGid) {
      settlement = await settle({ database, agreement: open, adminForShop, now });
      const { admin } = await adminForShop(shopDomain);
      await cancelIfActive(admin, shopDomain, open.subscriptionGid);
    }
    const agreement = await database.$transaction(async (transaction) => {
      if (open) {
        const ended = await transaction.billingAgreement.updateMany({
          where: { id: open.id, shopId: shop.id, status: open.status }, data: { status: "SUPERSEDED", endedAt: now },
        });
        if (ended.count !== 1) throw new UserFacingError("Billing changed while saving. Run the command again.");
      }
      const last = await transaction.billingAgreement.findFirst({
        where: { shopId: shop.id }, orderBy: { version: "desc" }, select: { version: true },
      });
      const free = terms.mode === "FREE";
      return transaction.billingAgreement.create({ data: {
        shopId: shop.id, version: (last?.version ?? 0) + 1, mode: terms.mode,
        rateBasisPoints: terms.rateBasisPoints, cappedAmount: terms.cappedAmount, currencyCode,
        status: free ? "ACTIVE" : "PENDING_APPROVAL", requestedAt: now, activatedAt: free ? now : null,
      } });
    });
    return { outcome: terms.mode === "FREE" ? "free" : "requested", agreement, settlement };
  }, { database });
}

// Merchant action: creates the Shopify subscription for terms awaiting
// approval and returns the page where the merchant approves it.
export async function requestBillingApproval({ admin, shopDomain, returnUrl, database = prisma }) {
  const shop = await installedShop(database, shopDomain);
  return withShopSettingsLock(shopDomain, async () => {
    const agreement = await openAgreement(database, shop.id);
    if (agreement?.status !== "PENDING_APPROVAL") throw new UserFacingError("There are no billing terms waiting for approval.");
    const preferences = await readBillingPreferences(admin, shopDomain);
    if (preferences.billingCurrency !== agreement.currencyCode) {
      throw new UserFacingError("Your store's billing currency has changed. Contact us to update your billing terms.");
    }
    const created = await createUsageSubscription(admin, shopDomain, {
      name: subscriptionName(agreement.version), terms: describeRevenueShare(agreement),
      cappedAmount: money(agreement.cappedAmount), currencyCode: agreement.currencyCode,
      returnUrl, test: preferences.developmentStore,
    });
    await database.billingAgreement.updateMany({
      where: { id: agreement.id, shopId: shop.id, status: "PENDING_APPROVAL" },
      data: { subscriptionGid: created.subscriptionGid, usageLineItemGid: created.usageLineItemGid },
    });
    return created.confirmationUrl;
  }, { database });
}

// Merchant action: asks Shopify to approve the cap the operator raised.
export async function requestCapApproval({ admin, shopDomain, database = prisma }) {
  const shop = await installedShop(database, shopDomain);
  const agreement = await openAgreement(database, shop.id);
  if (agreement?.status !== "ACTIVE" || !agreement.pendingCappedAmount || !agreement.usageLineItemGid) {
    throw new UserFacingError("There is no new cap waiting for approval.");
  }
  return updateUsageCap(admin, shopDomain, {
    lineItemId: agreement.usageLineItemGid, cappedAmount: money(agreement.pendingCappedAmount),
    currencyCode: agreement.currencyCode,
  });
}

/**
 * The agreement change a Shopify subscription status implies, or null.
 * @param {{ status: string, pendingCappedAmount?: unknown }} agreement
 * @param {{ status: string, cappedAmount?: string | null }} subscription
 */
export function subscriptionTransition(agreement, { status, cappedAmount }, now) {
  if (agreement.status === "PENDING_APPROVAL") {
    if (status === "ACTIVE") return { status: "ACTIVE", activatedAt: now };
    if (status === "DECLINED") return { status: "DECLINED", endedAt: now };
    return null;
  }
  if (agreement.status !== "ACTIVE") return null;
  if (ENDED_SUBSCRIPTION.has(status)) return { status: "CANCELLED", endedAt: now };
  const pending = money(agreement.pendingCappedAmount);
  if (status === "ACTIVE" && pending && cappedAmount && moneyToScaled(cappedAmount) >= moneyToScaled(pending)) {
    return { cappedAmount: money(cappedAmount), pendingCappedAmount: null };
  }
  return null;
}

async function applyTransition(database, agreement, patch, now, extra = {}) {
  const { count } = await database.billingAgreement.updateMany({
    where: { id: agreement.id, shopId: agreement.shopId, status: agreement.status }, data: { ...patch, ...extra },
  });
  if (count && "pendingCappedAmount" in patch) {
    // Charges held at the old cap can be billed now.
    await database.billingCharge.updateMany({
      where: { shopId: agreement.shopId, agreementId: agreement.id, status: "CAP_EXCEEDED" }, data: { nextAttemptAt: now },
    });
  }
  return count > 0;
}

// app_subscriptions/update. The authenticated shop scopes the lookup, so a
// payload can only change that shop's own agreement.
export async function applySubscriptionWebhook({ shopDomain, payload, database = prisma, now = new Date() }) {
  const subscription = payload?.app_subscription;
  const subscriptionGid = subscription?.admin_graphql_api_id;
  if (typeof subscriptionGid !== "string" || typeof subscription.status !== "string") return "ignored";
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) return "ignored";
  const payloadShop = subscription.admin_graphql_api_shop_id;
  if (payloadShop && shop.shopGid && payloadShop !== shop.shopGid) {
    reportCondition("billing_webhook_shop_mismatch", { shopId: shop.id });
    return "ignored";
  }
  const agreement = await database.billingAgreement.findFirst({ where: { shopId: shop.id, subscriptionGid } });
  if (!agreement) return "unmatched";
  const patch = subscriptionTransition(agreement, {
    status: subscription.status.toUpperCase(), cappedAmount: subscription.capped_amount ?? null,
  }, now);
  if (!patch) return "unchanged";
  await applyTransition(database, agreement, patch, now);
  logEvent("billing_agreement_updated", { shopId: shop.id, agreementId: agreement.id, status: patch.status ?? agreement.status });
  return "updated";
}

function billingView(agreement, subscription = null) {
  if (!agreement || agreement.mode === "FREE") {
    return { mode: "FREE", status: "ACTIVE", terms: describeRevenueShare({ mode: "FREE" }) };
  }
  const usage = subscription?.usageLineItem;
  return {
    mode: agreement.mode, status: agreement.status, terms: describeRevenueShare(agreement),
    currencyCode: agreement.currencyCode,
    cappedAmount: formatAmount(agreement.cappedAmount, agreement.currencyCode),
    pendingCappedAmount: agreement.pendingCappedAmount
      ? formatAmount(agreement.pendingCappedAmount, agreement.currencyCode) : null,
    billedThisCycle: usage ? formatAmount(usage.balanceUsed, agreement.currencyCode) : null,
    cycleEndsAt: subscription?.currentPeriodEnd?.toISOString() ?? null,
  };
}

// The shop's billing as stored, without asking Shopify.
export async function readBillingView({ shopDomain, database = prisma }) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  return billingView(shop ? await openAgreement(database, shop.id) : null);
}

// Reconciles the open agreement with Shopify when Settings loads or a webhook
// names a subscription we have not stored: adopts an approved subscription by
// its name, ends terms Shopify ended, and cancels stray revenue-share
// subscriptions that no open terms own.
export async function syncBillingAgreement({ admin, shopDomain, database = prisma, now = new Date() }) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  let agreement = shop ? await openAgreement(database, shop.id) : null;
  if (!agreement || agreement.mode === "FREE") return billingView(agreement);

  const subscriptions = await readActiveSubscriptions(admin, shopDomain);
  let current = null;
  if (agreement.status === "PENDING_APPROVAL") {
    current = subscriptions.find((subscription) => subscription.name === subscriptionName(agreement.version) &&
      subscription.status === "ACTIVE" && subscription.usageLineItem) ?? null;
    if (current && await applyTransition(database, agreement, { status: "ACTIVE", activatedAt: now }, now, {
      subscriptionGid: current.id, usageLineItemGid: current.usageLineItem.id,
    })) {
      agreement = { ...agreement, status: "ACTIVE", activatedAt: now, subscriptionGid: current.id };
    }
  } else {
    current = subscriptions.find((subscription) => subscription.id === agreement.subscriptionGid) ?? null;
    const shopify = current ?? (agreement.subscriptionGid
      ? await readSubscription(admin, shopDomain, agreement.subscriptionGid) : null);
    const patch = shopify && subscriptionTransition(agreement, {
      status: shopify.status, cappedAmount: shopify.usageLineItem?.cappedAmount ?? null,
    }, now);
    if (patch && await applyTransition(database, agreement, patch, now)) agreement = { ...agreement, ...patch };
  }

  for (const stray of subscriptions) {
    // The open terms own their stored subscription and any named for their
    // version (a concurrent load may have adopted it after we read the row).
    if (!stray.name.startsWith(SUBSCRIPTION_PREFIX) || stray.id === agreement.subscriptionGid ||
      stray.name === subscriptionName(agreement.version)) continue;
    await cancelSubscription(admin, shopDomain, stray.id);
    logEvent("billing_stray_subscription_cancelled", { shopId: shop.id, agreementId: agreement.id });
  }
  return billingView(OPEN.includes(agreement.status) ? agreement : null, current);
}
