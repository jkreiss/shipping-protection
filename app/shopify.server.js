import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

class ShopAwareSessionStorage {
  constructor(database) {
    this.database = database;
    this.delegate = new PrismaSessionStorage(database);
  }

  async storeSession(session) {
    await this.database.shop.upsert({
      where: { shopDomain: session.shop },
      create: { shopDomain: session.shop },
      update: {
        installationState: "INSTALLED",
        uninstalledAt: null,
      },
    });
    return this.delegate.storeSession(session);
  }

  loadSession(id) {
    return this.delegate.loadSession(id);
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

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new ShopAwareSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
