import prisma from "./db.server.js";

export async function ensureInstalledShop(shopDomain, shopGid = undefined) {
  return prisma.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      ...(shopGid ? { shopGid } : {}),
    },
    update: {
      installationState: "INSTALLED",
      uninstalledAt: null,
      ...(shopGid ? { shopGid } : {}),
    },
  });
}

export async function markShopUninstalled(shopDomain) {
  await prisma.$transaction(async (transaction) => {
    await transaction.session.deleteMany({ where: { shop: shopDomain } });
    await transaction.shop.updateMany({
      where: { shopDomain },
      data: {
        installationState: "UNINSTALLED",
        uninstalledAt: new Date(),
      },
    });
  });
}

export async function deleteShopData(shopDomain) {
  await prisma.$transaction((transaction) => redactShopData(transaction, shopDomain));
}

export async function redactShopData(transaction, shopDomain) {
  const shop = await transaction.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return;
  // The database rejects ordinary ClaimEvent mutation. This setting is local
  // to the redaction transaction and permits only event deletion.
  await transaction.$executeRawUnsafe("SET LOCAL app.allow_shop_redaction = 'on'");
  await transaction.claimEvent.deleteMany({ where: { shopId: shop.id } });
  await transaction.claim.deleteMany({ where: { shopId: shop.id } });
  await transaction.protectionRefund.deleteMany({ where: { shopId: shop.id } });
  await transaction.protectionPurchase.deleteMany({ where: { shopId: shop.id } });
  await transaction.orderLine.deleteMany({ where: { shopId: shop.id } });
  await transaction.order.deleteMany({ where: { shopId: shop.id } });
  await transaction.shop.update({ where: { id: shop.id }, data: {
    activePricingRuleId: null, activePricingRuleShopId: null,
  } });
  await transaction.pricingRule.deleteMany({ where: { shopId: shop.id } });
  await transaction.session.deleteMany({ where: { shop: shopDomain } });
  await transaction.shop.deleteMany({ where: { shopDomain } });
}
