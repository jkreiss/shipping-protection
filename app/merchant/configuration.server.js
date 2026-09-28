import prisma from "../db.server";

export async function getShopConfiguration(shopDomain, { legacyReady = false, database = prisma } = {}) {
  const shop = await database.shop.findUnique({
    where: { shopDomain },
    include: { configuration: true },
  });
  if (!shop) throw new Error("Installed shop is unavailable.");
  if (shop.configuration) return shop.configuration;
  return database.shopConfiguration.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      ...(legacyReady ? {
        protectionEnabled: true,
        stolenCoverageEnabled: true,
        lostCoverageEnabled: true,
        damagedCoverageEnabled: true,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      } : {}),
    },
    update: {},
  });
}

export async function enableShopProtection(shopDomain, database = prisma) {
  const shop = await database.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) throw new Error("Installed shop is unavailable.");
  return database.shopConfiguration.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      protectionEnabled: true,
      stolenCoverageEnabled: true,
      lostCoverageEnabled: true,
      damagedCoverageEnabled: true,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    },
    update: {
      protectionEnabled: true,
      stolenCoverageEnabled: true,
      lostCoverageEnabled: true,
      damagedCoverageEnabled: true,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    },
  });
}
