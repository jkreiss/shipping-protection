import prisma from "../db.server";

export async function getShopConfiguration(shopDomain, { database = prisma } = {}) {
  const shop = await database.shop.findUnique({
    where: { shopDomain },
    include: { configuration: true },
  });
  if (!shop) throw new Error("Installed shop is unavailable.");
  if (shop.configuration) return shop.configuration;
  return database.shopConfiguration.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id },
    update: {},
  });
}

// Only benefits customers don't already have can be sold. Loss and damage in
// transit are the merchant's existing Australian Consumer Law obligation
// (docs/agents/legal-product.md), so setup never enables them.
export async function enableShopProtection(shopDomain, database = prisma) {
  const shop = await database.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) throw new Error("Installed shop is unavailable.");
  return database.shopConfiguration.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      protectionEnabled: true,
      stolenCoverageEnabled: true,
      lostCoverageEnabled: false,
      damagedCoverageEnabled: false,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    },
    update: {
      protectionEnabled: true,
      stolenCoverageEnabled: true,
      lostCoverageEnabled: false,
      damagedCoverageEnabled: false,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    },
  });
}
