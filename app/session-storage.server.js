import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { InstallationAccessLostError, lockShopRow } from "./shop.server.js";
import { adminGraphql } from "./shopify/admin-graphql.server.js";

export const SESSION_INSTALLATION_QUERY = `#graphql
  query VerifySessionInstallation {
    shop { id myshopifyDomain }
    currentAppInstallation { id }
  }
`;

async function verifyInstallation(session) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(session.shop))
    throw new InstallationAccessLostError();
  return adminGraphql(
    {
      graphql: async (query, options) => {
        const timeout = AbortSignal.timeout(30_000);
        const response = await fetch(
          `https://${session.shop}/admin/api/2026-07/graphql.json`,
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

const prismaDelegate = (database) => new PrismaSessionStorage(database);

export class ShopAwareSessionStorage {
  constructor(
    database,
    {
      verifySession = verifyInstallation,
      delegateFactory = prismaDelegate,
    } = {},
  ) {
    this.database = database;
    this.delegateFactory = delegateFactory;
    this.delegate = delegateFactory(database);
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
    const verified = session.accessToken
      ? await this.verifySession(session)
      : null;
    if (
      session.accessToken &&
      (!verified?.currentAppInstallation?.id ||
        verified?.shop?.myshopifyDomain !== session.shop ||
        !/^gid:\/\/shopify\/Shop\/\d+$/.test(verified.shop.id))
    ) {
      throw new InstallationAccessLostError();
    }
    return this.database.$transaction(async (transaction) => {
      if (!session.accessToken && !before)
        throw new InstallationAccessLostError();
      const shop = await lockShopRow(transaction, session.shop);
      if (
        shop.installationGeneration !== generation ||
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
      const stored =
        await this.delegateFactory(transaction).storeSession(session);
      if (!stored) throw new InstallationAccessLostError();
      this.generations.set(
        session,
        generation + (shop.installationState === "UNINSTALLED" ? 1 : 0),
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
    if (!shop || shop.installationState !== "INSTALLED") return undefined;
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
