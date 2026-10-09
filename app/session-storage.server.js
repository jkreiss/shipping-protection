import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { InstallationAccessLostError, isInstalledAtGeneration, lockShopRow } from "./shop.server.js";
import { adminApiVersion } from "./shopify/api-version.server.js";
import { adminGraphql, isAccessLost } from "./shopify/admin-graphql.server.js";

export const SESSION_INSTALLATION_QUERY = `#graphql
  query VerifySessionInstallation {
    shop { id myshopifyDomain }
    currentAppInstallation { id }
  }
`;

// Decides "is the app installed" from a SESSION_INSTALLATION_QUERY result:
// Shopify answered for this shop, with a well-formed shop ID, and reports a
// current installation of this app.
function installationConfirmed(data, shopDomain) {
  return Boolean(
    data?.currentAppInstallation?.id &&
    data.shop?.myshopifyDomain === shopDomain &&
    /^gid:\/\/shopify\/Shop\/\d+$/.test(data.shop.id),
  );
}

// Uses its own transport because the session being verified isn't stored yet,
// so unauthenticated.admin can't load it; a 401 means the token is rejected.
async function verifyInstallation(session) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(session.shop))
    throw new InstallationAccessLostError();
  return adminGraphql(
    {
      graphql: async (query, options) => {
        const timeout = AbortSignal.timeout(30_000);
        const response = await fetch(
          `https://${session.shop}/admin/api/${adminApiVersion}/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({ query, variables: options.variables }),
            redirect: "error",
            signal: options.signal
              ? AbortSignal.any([options.signal, timeout])
              : timeout,
          },
        );
        if (response.status === 401) throw new InstallationAccessLostError();
        if (!response.ok)
          throw new Error(
            `Shopify installation verification HTTP ${response.status}.`,
          );
        return response;
      },
    },
    SESSION_INSTALLATION_QUERY,
    {},
    { shop: session.shop },
  );
}

export class ShopAwareSessionStorage {
  constructor(
    database,
    { verifySession = verifyInstallation, delegate } = {},
  ) {
    this.database = database;
    this.delegate = delegate ?? new PrismaSessionStorage(database);
    this.verifySession = verifySession;
    this.generations = new WeakMap();
  }

  async storeSession(session) {
    const before = await this.database.shop.findUnique({
      where: { shopDomain: session.shop },
    });
    const generation =
      this.generations.get(session) ?? before?.installationGeneration ?? 0;
    // Shopify invalidates a token by saving the loaded session without a token.
    // Keep that SDK behavior, but never create an installation from such a save.
    let verified = null;
    let unverified = false;
    if (session.accessToken) {
      try {
        verified = await this.verifySession(session);
      } catch (error) {
        // A refresh has already consumed the old refresh token, so an installed
        // shop keeps the new one through a transient verification failure.
        if (isAccessLost(error) || before?.installationState !== "INSTALLED")
          throw error;
        unverified = true;
      }
    }
    if (
      session.accessToken &&
      !unverified &&
      !installationConfirmed(verified, session.shop)
    ) {
      throw new InstallationAccessLostError();
    }
    return this.database.$transaction(async (transaction) => {
      if (!session.accessToken && !before)
        throw new InstallationAccessLostError();
      const shop = await lockShopRow(transaction, session.shop);
      // A sibling exchange that read the same uninstalled shop may have
      // completed this reinstall first; one generation ahead is that reinstall.
      const reinstalled =
        verified &&
        before?.installationState === "UNINSTALLED" &&
        shop.installationState === "INSTALLED" &&
        shop.installationGeneration === generation + 1;
      if (
        (shop.installationGeneration !== generation && !reinstalled) ||
        (!verified && shop.installationState !== "INSTALLED")
      ) {
        throw new InstallationAccessLostError();
      }
      if (
        verified &&
        (shop.installationState === "UNINSTALLED" ||
          shop.shopGid !== verified.shop.id)
      ) {
        await transaction.shop.update({
          where: { id: shop.id },
          data: {
            shopGid: verified.shop.id,
            installationState: "INSTALLED",
            uninstalledAt: null,
            installationGeneration: {
              increment: shop.installationState === "UNINSTALLED" ? 1 : 0,
            },
          },
        });
      }
      // The SDK retains all online/offline and rotating refresh-token fields.
      const data = this.delegate.sessionToRow(session);
      await transaction.session.upsert({
        where: { id: session.id },
        update: data,
        create: data,
      });
      this.generations.set(
        session,
        shop.installationGeneration +
          (shop.installationState === "UNINSTALLED" ? 1 : 0),
      );
      return true;
    });
  }

  async loadSession(id) {
    const candidate = await this.delegate.loadSession(id);
    if (!candidate) return undefined;
    const shop = await this.database.shop.findUnique({
      where: { shopDomain: candidate.shop },
    });
    if (!isInstalledAtGeneration(shop)) return undefined;
    // Read after the generation snapshot: a token from before reinstall must
    // never be labelled with the new generation (including token invalidation).
    const session = await this.delegate.loadSession(id);
    if (!session || session.shop !== candidate.shop) return undefined;
    this.generations.set(session, shop.installationGeneration);
    return session;
  }
  deleteSession(id) {
    return this.delegate.deleteSession(id);
  }
  deleteSessions(ids) {
    return this.delegate.deleteSessions(ids);
  }
  findSessionsByShop(shop) {
    return this.delegate.findSessionsByShop(shop);
  }
  isReady() {
    return this.delegate.isReady();
  }
}
