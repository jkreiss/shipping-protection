import prisma from "./db.server";

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
  await prisma.$transaction(async (transaction) => {
    await transaction.session.deleteMany({ where: { shop: shopDomain } });
    await transaction.shop.deleteMany({ where: { shopDomain } });
  });
}
