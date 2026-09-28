import prisma from "./db.server.js";
import {
  PROTECTION_ATTRIBUTE_NAMES,
  moneyToScaled,
  normalizeWebhookOrder,
  scaledToMoney,
} from "./order-normalization.js";
import { normalizeGraphqlOrder } from "./order-normalization.js";
import { fetchShopifyOrder } from "./order-shopify.server.js";
import { classifyProtectionRefund } from "./protection-refunds.js";
import { PRICING_SCHEMA_VERSION } from "./pricing-contract.js";

function sanitizeError(error) {
  const text = error instanceof Error ? error.message : "Unknown persistence error";
  return text
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@")
    .replace(/\b(password|secret|token)=([^\s;]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

function hasProvenance(line) {
  return PROTECTION_ATTRIBUTE_NAMES.some(
    (name) => line.protectionAttributes[name] !== undefined,
  );
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
    ruleVersion: Number.isInteger(ruleVersion) ? ruleVersion : null,
    rateBasisPoints: Number.isInteger(rateBasisPoints) ? rateBasisPoints : null,
    basis: attributes._yasas_protection_basis ?? null,
    pricingContractVersion: Number.isInteger(pricingContractVersion) && pricingContractVersion >= 1
      ? pricingContractVersion : null,
    status: rule ? "ATTRIBUTED" : "UNATTRIBUTED",
  };
}

export async function persistNormalizedOrder(
  transaction,
  shop,
  normalized,
) {
  const rules = await transaction.pricingRule.findMany({
    where: { shopId: shop.id },
  });
  const protectionVariants = new Set(rules.map(({ variantId }) => variantId));
  const lines = normalized.lines.map((line) => ({
    ...line,
    isProtection:
      (line.variantId && protectionVariants.has(line.variantId)) ||
      hasProvenance(line),
  }));
  const existing = await transaction.order.findUnique({
    where: { shopId_shopifyOrderId: { shopId: shop.id, shopifyOrderId: normalized.shopifyOrderId } },
  });
  if (existing?.shopifyUpdatedAt > normalized.shopifyUpdatedAt) return existing;
  const eligible = lines.some((line) => !line.isProtection && line.requiresShipping && line.quantity > 0);
  const protectedLines = lines.filter((line) => line.isProtection);
  const firstPayment = Boolean(normalized.paidAt && !existing?.firstPaidAt);
  const paidFacts = firstPayment ? { firstPaidAt: normalized.paidAt, paidEligible: eligible } : {};
  const { lines: ignoredLines, refunds: ignoredRefunds, paidAt: ignoredPaidAt, ...fields } = normalized;
  void ignoredLines;
  void ignoredRefunds;
  void ignoredPaidAt;

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
      ...paidFacts,
    },
    update: {
      ...fields,
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

  if (!confirmedPurchase && (!existing?.firstPaidAt || firstPayment) && protectedLines.length > 0) {
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
      .reduce((sum, line) => sum + moneyToScaled(line.preDiscountAmount), 0n);
    const fee = protectedLines.reduce((sum, line) => sum + moneyToScaled(line.finalAmount), 0n);
    const purchase = {
      pricingRuleId: selected.rule?.id ?? null,
      ruleId: selected.ruleId,
      ruleVersion: selected.ruleVersion,
      rateBasisPoints: selected.rateBasisPoints,
      basis: selected.basis,
      pricingContractVersion: selected.pricingContractVersion,
      currencyCode: normalized.currencyCode,
      eligibleSubtotalAmount: scaledToMoney(eligibleSubtotal),
      feeAmount: scaledToMoney(fee),
      protectionLineIds: protectedLines.map((line) => line.shopifyLineItemId),
      purchasedAt: firstPayment ? normalized.paidAt : null,
      attributionStatus: selected.status,
    };
    confirmedPurchase = await transaction.protectionPurchase.upsert({
      where: { orderId_shopId: purchaseKey },
      create: { ...purchaseKey, ...purchase },
      update: purchase,
    });
  } else if (!confirmedPurchase && (protectedLines.length === 0 || existing?.firstPaidAt)) {
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
  for (const refund of normalized.refunds) {
    const result = classifyProtectionRefund(refund, {
      currencyCode,
      protectionLineIds,
      knownLineIds,
      protectedOrder: Boolean(paidPurchase),
    });
    if (result.status === "IGNORED") continue;
    await transaction.protectionRefund.upsert({
      where: { shopId_shopifyRefundId: { shopId: shop.id, shopifyRefundId: refund.id } },
      create: { shopId: shop.id, orderId: order.id, shopifyRefundId: refund.id,
        status: result.status, amount: result.amount, currencyCode, succeededAt: result.succeededAt },
      update: { status: result.status, amount: result.amount, currencyCode, succeededAt: result.succeededAt },
    });
  }
}

export async function processOrderWebhook({
  shopDomain,
  webhookId,
  eventId = null,
  topic = "ORDERS_CREATE",
  payload,
  admin = null,
  hashSecret = process.env.CHECKOUT_TOKEN_HASH_SECRET,
  database = prisma,
}) {
  if (!webhookId) throw new Error("X-Shopify-Webhook-Id is required.");
  try {
    const orderId = topic === "REFUNDS_CREATE"
      ? payload?.order_id
      : payload?.admin_graphql_api_id ?? payload?.id;
    const graphqlId = typeof orderId === "string" && orderId.startsWith("gid://")
      ? orderId : `gid://shopify/Order/${orderId}`;
    const normalized = admin
      ? normalizeGraphqlOrder(await fetchShopifyOrder(admin, graphqlId), hashSecret)
      : normalizeWebhookOrder(payload, hashSecret);
    return await database.$transaction(async (transaction) => {
      const shop = await transaction.shop.upsert({
        where: { shopDomain },
        create: { shopDomain },
        update: {},
      });
      const existing = await transaction.webhookDelivery.findUnique({
        where: { shopId_webhookId: { shopId: shop.id, webhookId } },
      });
      if (existing?.status === "PROCESSED") {
        return { duplicate: true, order: null };
      }

      const delivery = existing
        ? await transaction.webhookDelivery.update({
            where: { id: existing.id },
            data: {
              eventId,
              topic,
              status: "PROCESSING",
              errorMessage: null,
              failedAt: null,
            },
          })
        : await transaction.webhookDelivery.create({
            data: { shopId: shop.id, webhookId, eventId, topic },
          });
      const order = await persistNormalizedOrder(transaction, shop, normalized);
      await transaction.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      return { duplicate: false, order };
    }, { isolationLevel: "Serializable", timeout: 20_000 });
  } catch (error) {
    if (["P2002", "P2034"].includes(error?.code)) {
      const duplicateShop = await database.shop.findUnique({
        where: { shopDomain },
      });
      const duplicate = duplicateShop
        ? await database.webhookDelivery.findUnique({
            where: {
              shopId_webhookId: { shopId: duplicateShop.id, webhookId },
            },
          })
        : null;
      if (duplicate?.status === "PROCESSED") {
        return { duplicate: true, order: null };
      }
    }
    const shop = await database.shop.upsert({
      where: { shopDomain },
      create: { shopDomain },
      update: {},
    });
    await database.webhookDelivery.upsert({
      where: { shopId_webhookId: { shopId: shop.id, webhookId } },
      create: {
        shopId: shop.id,
        webhookId,
        eventId,
        topic,
        status: "FAILED",
        errorMessage: sanitizeError(error),
        failedAt: new Date(),
      },
      update: {
        status: "FAILED",
        errorMessage: sanitizeError(error),
        failedAt: new Date(),
      },
    });
    throw error;
  }
}
