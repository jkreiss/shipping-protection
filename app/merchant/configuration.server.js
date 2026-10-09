import { withInstalledShopWrite } from "../settings-lease-context.server.js";
import prisma from "../db.server";
import { isInstalledAtGeneration } from "../shop.server.js";

export async function getShopConfiguration(
  shopDomain,
  { database = prisma } = {},
) {
  const shop = await database.shop.findUnique({
    where: { shopDomain },
    include: { configuration: true },
  });
  if (!isInstalledAtGeneration(shop))
    throw new Error("Installed shop is unavailable.");
  if (shop.configuration) return shop.configuration;
  return withInstalledShopWrite(
    database,
    shopDomain,
    (transaction, installed) =>
      transaction.shopConfiguration.upsert({
        where: { shopId: installed.id },
        create: { shopId: installed.id },
        update: {},
      }),
  );
}

// The initial release is for US stores, whose copy offers protection for
// stolen, damaged, and undelivered packages, so setup turns on all three flags.
// Australian stores come later with their own settings; their existing
// Australian Consumer Law remedies must never be sold (docs/agents/legal-product.md).
export async function enableShopProtection(shopDomain, database = prisma) {
  return withInstalledShopWrite(database, shopDomain, (transaction, shop) =>
    transaction.shopConfiguration.upsert({
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
    }),
  );
}

export async function disableShopProtection(shopDomain, database = prisma) {
  return withInstalledShopWrite(database, shopDomain, (transaction, shop) =>
    transaction.shopConfiguration.upsert({
      where: { shopId: shop.id },
      // Turning off only ever follows a checkout setup. A shop whose strategy is
      // still NONE would otherwise never read as deliberately off.
      create: {
        shopId: shop.id,
        protectionEnabled: false,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      },
      update: {
        protectionEnabled: false,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      },
    }),
  );
}
