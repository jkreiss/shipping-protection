import { retrySerializationFailures } from "./serializable-retry.server.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { UserFacingError } from "./user-facing-error.js";

/** @typedef {{shopDomain: string, signal: AbortSignal, assertHeld: (database?: object) => Promise<void>}} SettingsLease */
/** @type {AsyncLocalStorage<SettingsLease>} */
export const settingsLeaseContext = new AsyncLocalStorage();

export async function assertSettingsLease(database, shopDomain) {
  const lease = settingsLeaseContext.getStore();
  if (!lease) return;
  if (shopDomain && lease.shopDomain !== shopDomain)
    throw new Error("Settings tenant mismatch.");
  await lease.assertHeld(database);
}

// A no-op owner-conditioned update holds the shop row through the local commit,
// serializing it with uninstall, takeover, and renewal.
export async function guardInstalledShopWrite(transaction, shop) {
  await assertSettingsLease(transaction, shop.shopDomain);
  if (shop.installationState !== "INSTALLED")
    throw new UserFacingError("Installed shop is unavailable.");
  const { count } = await transaction.shop.updateMany({
    where: {
      id: shop.id,
      installationState: "INSTALLED",
      installationGeneration: shop.installationGeneration,
    },
    data: { installationGeneration: shop.installationGeneration },
  });
  settingsLeaseContext.getStore()?.signal.throwIfAborted();
  if (count !== 1) throw new UserFacingError("Installed shop is unavailable.");
}

export async function withInstalledShopWrite(database, shopDomain, run) {
  return retrySerializationFailures(() =>
    database.$transaction(async (transaction) => {
      const shop = await transaction.shop.findUnique({ where: { shopDomain } });
      if (!shop) throw new UserFacingError("Installed shop is unavailable.");
      await guardInstalledShopWrite(transaction, shop);
      const result = await run(transaction, shop);
      // A renewal can fail while a local query is pending. Roll back rather than
      // committing changes after the lease has been revoked.
      await assertSettingsLease(transaction, shopDomain);
      return result;
    }),
  );
}
