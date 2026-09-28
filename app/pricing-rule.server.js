import { randomUUID } from "node:crypto";
import prisma from "./db.server";
import {
  PRICING_BASIS,
  pricingContractForRule,
  validateRateBasisPoints,
} from "./pricing-contract";

function sanitizeFailure(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@")
    .replace(/\b(password|secret|token)=([^\s;]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

async function finalizeRule(database, shopId, ruleId, now = new Date()) {
  return database.$transaction(async (transaction) => {
    await transaction.pricingRule.updateMany({
      where: { shopId, state: "ACTIVE", id: { not: ruleId } },
      data: { state: "SUPERSEDED" },
    });
    const active = await transaction.pricingRule.update({
      where: { id_shopId: { id: ruleId, shopId } },
      data: {
        state: "ACTIVE",
        publishedAt: now,
        activatedAt: now,
        failedAt: null,
        failureReason: null,
      },
    });
    await transaction.shop.update({
      where: { id: shopId },
      data: { activePricingRuleId: ruleId, activePricingRuleShopId: shopId },
    });
    return active;
  });
}

export async function createAndPublishPricingRule({
  admin,
  shopDomain,
  productId,
  variantId,
  rateBasisPoints,
  publishSnapshot,
  database = prisma,
  now = () => new Date(),
  createRuleId = randomUUID,
}) {
  validateRateBasisPoints(rateBasisPoints);

  const pending = await database.$transaction(
    async (transaction) => {
      const shop = await transaction.shop.upsert({
        where: { shopDomain },
        create: { shopDomain },
        update: { installationState: "INSTALLED", uninstalledAt: null },
      });
      const newest = await transaction.pricingRule.findFirst({
        where: { shopId: shop.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      return transaction.pricingRule.create({
        data: {
          shopId: shop.id,
          ruleId: createRuleId(),
          version: (newest?.version ?? 0) + 1,
          productId,
          variantId,
          rateBasisPoints,
          basis: PRICING_BASIS,
          state: "PENDING",
          effectiveAt: now(),
        },
      });
    },
    { isolationLevel: "Serializable" },
  );

  const snapshot = pricingContractForRule(
    pending,
    productId,
    variantId,
    true,
  );
  let published = false;

  try {
    await publishSnapshot(admin, snapshot);
    published = true;
    const active = await finalizeRule(database, pending.shopId, pending.id, now());
    return { rule: active, snapshot };
  } catch (error) {
    if (!published) {
      await database.pricingRule.update({
        where: { id: pending.id },
        data: {
          state: "FAILED",
          failedAt: now(),
          failureReason: sanitizeFailure(error),
        },
      });
    }
    throw error;
  }
}

export async function reconcilePublishedPricingRule(
  shopDomain,
  snapshot,
  database = prisma,
) {
  if (snapshot?.schemaVersion !== 2) return null;

  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (!shop) return null;
  const rule = await database.pricingRule.findFirst({
    where: {
      shopId: shop.id,
      ruleId: snapshot.ruleId,
      version: snapshot.ruleVersion,
      rateBasisPoints: snapshot.rateBasisPoints,
      basis: snapshot.basis,
    },
  });
  if (!rule) return null;
  if (rule.state === "ACTIVE" && shop.activePricingRuleId === rule.id) {
    return rule;
  }
  if (rule.state !== "PENDING" && rule.state !== "ACTIVE") return null;

  return finalizeRule(database, shop.id, rule.id);
}

export async function getActivePricingRule(shopDomain, database = prisma) {
  return database.shop
    .findUnique({
      where: { shopDomain },
      include: { activePricingRule: true },
    })
    .then((shop) => shop?.activePricingRule?.shopId === shop?.id
      ? shop.activePricingRule
      : null);
}
