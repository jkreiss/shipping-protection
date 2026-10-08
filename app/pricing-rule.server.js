import {
  assertSettingsLease,
  guardInstalledShopWrite,
  withInstalledShopWrite,
} from "./settings-lease-context.server.js";
import { reportFailure } from "./observability.server.js";
import { randomUUID } from "node:crypto";
import prisma from "./db.server";
import { retrySerializationFailures } from "./serializable-retry.server";
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

// With onlyIfNewer, a rule that a newer one has already replaced is left alone
// and null is returned, so a late reconcile cannot roll the database back.
async function finalizeRule(
  database,
  shopId,
  rule,
  { now = new Date(), onlyIfNewer = false, installationGeneration } = {},
) {
  return retrySerializationFailures(() =>
    database.$transaction(
      async (transaction) => {
        const shop = await transaction.shop.findUnique({
          where: { id: shopId },
          include: { activePricingRule: true },
        });
        if (
          !shop ||
          shop.installationState !== "INSTALLED" ||
          (installationGeneration !== undefined &&
            shop.installationGeneration !== installationGeneration)
        ) {
          throw new Error("Installed shop changed during pricing publication.");
        }
        await guardInstalledShopWrite(transaction, shop);
        if (onlyIfNewer && shop.activePricingRule?.version > rule.version)
          return null;
        await transaction.pricingRule.updateMany({
          where: { shopId, state: "ACTIVE", id: { not: rule.id } },
          data: { state: "SUPERSEDED" },
        });
        const active = await transaction.pricingRule.update({
          where: { id_shopId: { id: rule.id, shopId } },
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
          data: {
            activePricingRuleId: rule.id,
            activePricingRuleShopId: shopId,
          },
        });
        await assertSettingsLease(transaction, shop.shopDomain);
        return active;
      },
      { isolationLevel: "Serializable" },
    ),
  );
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

  let installationGeneration;
  const pending = await retrySerializationFailures(() =>
    database.$transaction(
      async (transaction) => {
        const shop = await transaction.shop.findUnique({
          where: { shopDomain },
        });
        if (!shop) throw new Error("Installed shop is unavailable.");
        await guardInstalledShopWrite(transaction, shop);
        installationGeneration = shop.installationGeneration;
        const newest = await transaction.pricingRule.findFirst({
          where: { shopId: shop.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const rule = await transaction.pricingRule.create({
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
        await assertSettingsLease(transaction, shopDomain);
        return rule;
      },
      { isolationLevel: "Serializable" },
    ),
  );

  const snapshot = pricingContractForRule(pending, productId, variantId, true);
  let published = false;

  try {
    await assertSettingsLease(database, shopDomain);
    const shop = await database.shop.findUnique({ where: { shopDomain } });
    if (
      !shop ||
      shop.installationState !== "INSTALLED" ||
      shop.installationGeneration !== installationGeneration
    )
      throw new Error("Installed shop changed during pricing publication.");
    await publishSnapshot(admin, snapshot);
    published = true;
    const active = await finalizeRule(database, pending.shopId, pending, {
      now: now(),
      installationGeneration,
    });
    return { rule: active, snapshot };
  } catch (error) {
    if (!published) {
      try {
        await withInstalledShopWrite(
          database,
          shopDomain,
          async (transaction, shop) => {
            if (shop.installationGeneration !== installationGeneration)
              throw new Error(
                "Installed shop changed during pricing publication.",
              );
            await transaction.pricingRule.update({
              where: { id_shopId: { id: pending.id, shopId: pending.shopId } },
              data: {
                state: "FAILED",
                failedAt: now(),
                failureReason: sanitizeFailure(error),
              },
            });
          },
        );
      } catch (cleanupError) {
        reportFailure("pricing_failure_record_interrupted", cleanupError);
      }
    }
    throw error;
  }
}

export async function reconcilePublishedPricingRule(
  shopDomain,
  snapshot,
  database = prisma,
  installationGeneration,
) {
  if (
    snapshot?.schemaVersion !== 2 ||
    !Number.isInteger(installationGeneration) ||
    installationGeneration < 0
  )
    return null;

  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (
    !shop ||
    shop.installationState !== "INSTALLED" ||
    shop.installationGeneration !== installationGeneration
  )
    return null;
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
  // A publish that errored, such as a timeout, may still have reached Shopify.
  // Shopify's live config is authoritative, so a FAILED rule it uses is active.
  if (rule.state === "SUPERSEDED") return null;

  return finalizeRule(database, shop.id, rule, {
    onlyIfNewer: true,
    installationGeneration,
  });
}

export async function getActivePricingRule(shopDomain, database = prisma) {
  return database.shop
    .findUnique({
      where: { shopDomain },
      include: { activePricingRule: true },
    })
    .then((shop) =>
      shop && shop.activePricingRule?.shopId === shop.id
        ? shop.activePricingRule
        : null,
    );
}
