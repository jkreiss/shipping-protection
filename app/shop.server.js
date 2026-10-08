import { randomUUID } from "node:crypto";
import {
  assertSettingsLease,
  settingsLeaseContext,
} from "./settings-lease-context.server.js";
import { reportFailure } from "./observability.server.js";
import prisma from "./db.server.js";
import { UserFacingError } from "./user-facing-error.js";

// Session persistence and uninstall take this row lock before changing state.
// Creating the tombstone also serializes uninstall before the first session save.
export async function lockShopRow(transaction, shopDomain) {
  let [shop] =
    await transaction.$queryRaw`SELECT * FROM "Shop" WHERE "shopDomain" = ${shopDomain} FOR UPDATE`;
  if (!shop) {
    await transaction.shop.createMany({
      data: { shopDomain },
      skipDuplicates: true,
    });
    [shop] =
      await transaction.$queryRaw`SELECT * FROM "Shop" WHERE "shopDomain" = ${shopDomain} FOR UPDATE`;
  }
  return shop;
}

export class InstallationAccessLostError extends Error {
  constructor() {
    super(
      "Installed shop access is unavailable. Reload to authenticate again.",
    );
    this.response = { code: 401 };
  }
}

export async function ensureInstalledShop(
  shopDomain,
  shopGid = undefined,
  database = prisma,
  expectedGeneration = undefined,
) {
  const shop = await database.shop.findUnique({ where: { shopDomain } });
  if (
    !shop || shop.installationState !== "INSTALLED" ||
    (expectedGeneration !== undefined && shop.installationGeneration !== expectedGeneration)
  )
    throw new InstallationAccessLostError();
  if (!shopGid || shop.shopGid === shopGid) return shop;
  return database.$transaction(async (transaction) => {
    await assertSettingsLease(transaction, shopDomain);
    const updated = await transaction.shop.update({
      where: {
        id: shop.id,
        installationState: "INSTALLED",
        installationGeneration: shop.installationGeneration,
      },
      data: { shopGid },
    });
    await assertSettingsLease(transaction, shopDomain);
    return updated;
  });
}

export async function markShopUninstalled(shopDomain, database = prisma) {
  await database.$transaction(async (transaction) => {
    const shop = await lockShopRow(transaction, shopDomain);
    await transaction.shop.update({
      where: { id: shop.id },
      data: {
        installationState: "UNINSTALLED",
        installationGeneration: {
          increment: shop.installationState === "INSTALLED" ? 1 : 0,
        },
        uninstalledAt: shop.uninstalledAt ?? new Date(),
        settingsLockedUntil: null,
        settingsLockToken: null,
      },
    });
    await transaction.session.deleteMany({ where: { shop: shopDomain } });
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
  if (orders.length === 0) {
    // The order may still be queued, so the worker would store it after the
    // redaction. A redacted order that is not queued yet is normally older than
    // the 60 days of orders this app can read (read_orders without
    // read_all_orders), and Shopify sends the request well after that, so
    // nothing later re-fetches it and no tombstone is kept.
    await transaction.webhookDelivery.deleteMany({ where: { shopId: shop.id, shopifyOrderId: { in: shopifyOrderIds } } });
    return 0;
  }

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
const SETTINGS_RENEW_MS = 60_000;

export async function withShopSettingsLock(
  shopDomain,
  run,
  { database = prisma } = {},
) {
  if (typeof shopDomain !== "string" || !shopDomain)
    throw new Error("A shop domain is required.");
  const token = randomUUID();
  const now = new Date();
  const { count } = await database.shop.updateMany({
    where: {
      shopDomain,
      installationState: "INSTALLED",
      OR: [
        { settingsLockedUntil: null },
        { settingsLockedUntil: { lte: now } },
      ],
    },
    data: {
      settingsLockedUntil: new Date(now.getTime() + SETTINGS_LOCK_MS),
      settingsLockToken: token,
    },
  });
  if (count !== 1)
    throw new UserFacingError(
      "Another settings change is still saving. Try again in a moment.",
    );

  const controller = new AbortController();
  let lost;
  let stopped = false;
  let renewal = Promise.resolve();
  const interrupt = (cause) => {
    if (!lost) {
      lost = new UserFacingError(
        "This settings change was interrupted. Refresh to check its status, then try again.",
      );
      controller.abort(lost);
      if (cause) reportFailure("settings_lease_lost", cause);
    }
    return lost;
  };
  const ownedWhere = () => ({
    shopDomain,
    installationState: "INSTALLED",
    settingsLockToken: token,
    settingsLockedUntil: { gt: new Date() },
  });
  const assertHeld = async (target = database) => {
    if (lost) throw lost;
    try {
      const { count } = await target.shop.updateMany({
        where: ownedWhere(),
        data: { settingsLockToken: token },
      });
      if (lost) throw lost;
      if (count !== 1) throw interrupt();
    } catch (error) {
      // A rolled-back Serializable transaction can retry with the same owner.
      // Renewal failures are handled separately and still revoke the lease.
      if (error?.code === "P2034") throw error;
      throw interrupt(error);
    }
  };
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (stopped || lost) return;
      try {
        const { count } = await database.shop.updateMany({
          where: ownedWhere(),
          data: {
            settingsLockedUntil: new Date(Date.now() + SETTINGS_LOCK_MS),
          },
        });
        if (count !== 1) interrupt();
      } catch (error) {
        interrupt(error);
      }
    });
  }, SETTINGS_RENEW_MS);
  timer.unref?.();
  const lease = { shopDomain, signal: controller.signal, assertHeld };
  try {
    return await settingsLeaseContext.run(lease, async () => {
      const result = await run(lease);
      stopped = true;
      clearInterval(timer);
      await renewal;
      await assertHeld();
      return result;
    });
  } finally {
    stopped = true;
    clearInterval(timer);
    await renewal;
    try {
      await database.shop.updateMany({
        where: { shopDomain, settingsLockToken: token },
        data: { settingsLockedUntil: null, settingsLockToken: null },
      });
    } catch (error) {
      reportFailure("settings_lease_release_failed", error);
    }
  }
}
