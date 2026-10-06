import prisma from "../db.server.js";
import { withShopSettingsLock } from "../shop.server.js";
import { UserFacingError } from "../user-facing-error.js";

// Operator-only: do not expose this setter through merchant settings actions.
export async function setProtectionRateEditing(
  shopDomain,
  editable,
  { database = prisma } = {},
) {
  if (
    typeof shopDomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(
      shopDomain,
    ) ||
    typeof editable !== "boolean"
  ) {
    throw new UserFacingError(
      "Use a myshopify.com store domain and a boolean editing permission.",
    );
  }
  const shop = await database.shop.findUnique({
    where: { shopDomain },
    select: { id: true, installationState: true },
  });
  if (!shop || shop.installationState !== "INSTALLED") {
    throw new UserFacingError(
      "Choose an installed store before changing rate-editing access.",
    );
  }
  return withShopSettingsLock(
    shopDomain,
    () =>
      database.shopConfiguration.upsert({
        where: { shopId: shop.id },
        create: { shopId: shop.id, protectionRateEditable: editable },
        update: { protectionRateEditable: editable },
      }),
    { database },
  );
}
