import { adminGraphql } from "../order-shopify.server";
import prisma from "../db.server";
import { getShopConfiguration } from "../merchant/configuration.server";
import { resolveConfiguration } from "../merchant/resolve-configuration";

const CLAIM_LIST_LIMIT = 50;

export async function readClaimsOverview(admin, shopDomain, database = prisma) {
  const shop = await database.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) throw new Error("The authenticated shop is not installed.");
  // The tenant check above runs first so an unknown shop never reaches Shopify;
  // the rest are independent.
  const [data, settings, claims] = await Promise.all([
    adminGraphql(admin, `#graphql
      query ClaimsShop { shop { ianaTimezone } }
    `, {}, { shop: shopDomain }),
    getShopConfiguration(shopDomain, { database }),
    database.claim.findMany({
      where: { shopId: shop.id },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: CLAIM_LIST_LIMIT,
      select: {
        id: true, type: true, status: true, submittedAt: true,
        protectionPurchase: { select: { order: { select: { name: true, shopifyOrderId: true } } } },
      },
    }),
  ]);
  // Shopify capabilities only affect protection attachment, which this page
  // does not show; claims and returns availability comes from app support.
  const resolved = resolveConfiguration(settings, {}, false);
  return {
    timeZone: data.shop.ianaTimezone,
    claimIntakeEnabled: resolved.claimIntakeEnabled,
    returnsEnabled: resolved.returnsEnabled,
    claims: claims.map((claim) => ({
      id: claim.id, type: claim.type, status: claim.status,
      submittedAt: claim.submittedAt.toISOString(),
      orderName: claim.protectionPurchase.order.name,
      shopifyOrderId: claim.protectionPurchase.order.shopifyOrderId,
    })),
  };
}
