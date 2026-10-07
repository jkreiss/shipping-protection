import prisma from "./db.server.js";
import { UserFacingError } from "./user-facing-error.js";

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

export async function deleteCustomerOrders(shopDomain, orderIds) {
  return prisma.$transaction((transaction) => redactCustomerOrders(transaction, shopDomain, orderIds));
}

// Erases the orders a customers/redact request names. Shopify sends numeric
// order IDs; rows hold Admin GraphQL IDs. A malformed list is ignored rather
// than retried, since a retry would carry the same payload. Returns the number
// of orders deleted.
export async function redactCustomerOrders(transaction, shopDomain, orderIds) {
  const isOrderId = (id) => (Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && /^[1-9]\d*$/.test(id));
  if (!Array.isArray(orderIds) || orderIds.length === 0 || !orderIds.every(isOrderId)) return 0;
  const shopifyOrderIds = orderIds.map((id) => `gid://shopify/Order/${id}`);

  const shop = await transaction.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return 0;
  const orders = await transaction.order.findMany({
    where: { shopId: shop.id, shopifyOrderId: { in: shopifyOrderIds } }, select: { id: true },
  });
  if (orders.length === 0) return 0;

  await deleteOrderRecords(transaction, shop.id, orders.map((order) => order.id), shopifyOrderIds);
  return orders.length;
}

// Deletes one shop's orders and everything recorded against them, including
// webhook deliveries for those Shopify order IDs. Customer redaction and the
// retention purge share it.
export async function deleteOrderRecords(transaction, shopId, orderIds, shopifyOrderIds) {
  const ids = { in: orderIds };
  // Confirmed purchases and claim events reject ordinary deletes; this
  // transaction-local setting permits privacy deletion only.
  await transaction.$executeRawUnsafe("SET LOCAL app.allow_shop_redaction = 'on'");
  await transaction.claimEvent.deleteMany({ where: { shopId, claim: { protectionPurchase: { orderId: ids } } } });
  await transaction.claim.deleteMany({ where: { shopId, protectionPurchase: { orderId: ids } } });
  await transaction.protectionRefund.deleteMany({ where: { shopId, orderId: ids } });
  await transaction.protectionPurchase.deleteMany({ where: { shopId, orderId: ids } });
  await transaction.orderLine.deleteMany({ where: { shopId, orderId: ids } });
  await transaction.order.deleteMany({ where: { shopId, id: ids } });
  await transaction.webhookDelivery.deleteMany({ where: { shopId, shopifyOrderId: { in: shopifyOrderIds } } });
}

// Records the scopes Shopify reports for an installation (app/scopes_update).
// A payload without a list of scope names is ignored rather than retried, since
// a retry would carry the same payload.
export async function recordGrantedScopes({ shopDomain, sessionId, scopes, database = prisma }) {
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return false;
  await database.session.updateMany({
    where: { id: sessionId, shop: shopDomain },
    data: { scope: scopes.join(",") },
  });
  return true;
}

const SETTINGS_LOCK_MS = 5 * 60_000;

// Runs one protection setup, rate change, or turn-off at a time per shop. These publish
// pricing to Shopify and then record it locally; interleaved, the rate Shopify
// charges and the rate Settings shows can disagree. The lease expires on its
// own if the process dies mid-change.
export async function withShopSettingsLock(shopDomain, run, { database = prisma } = {}) {
  // An undefined domain would drop the filter and lock every shop.
  if (typeof shopDomain !== "string" || !shopDomain) throw new Error("A shop domain is required.");
  const now = new Date();
  const until = new Date(now.getTime() + SETTINGS_LOCK_MS);
  const { count } = await database.shop.updateMany({
    where: { shopDomain, OR: [{ settingsLockedUntil: null }, { settingsLockedUntil: { lte: now } }] },
    data: { settingsLockedUntil: until },
  });
  if (count === 0) {
    throw new UserFacingError("Another settings change is still saving. Try again in a moment.");
  }
  try {
    return await run();
  } finally {
    await database.shop.updateMany({
      where: { shopDomain, settingsLockedUntil: until },
      data: { settingsLockedUntil: null },
    });
  }
}
