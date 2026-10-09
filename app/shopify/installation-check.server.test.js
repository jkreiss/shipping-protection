import { describe, expect, test, vi } from "vitest";

vi.mock("../shopify.server.js", () => ({ unauthenticated: { admin: vi.fn() } }));
const { shopifyInstallationActive } = await import("./installation-check.server.js");

function adminReturning(response) {
  return {
    graphql: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return new Response(JSON.stringify(response));
    }),
  };
}

describe("shopifyInstallationActive", () => {
  test("is true when Shopify returns the app installation", async () => {
    const admin = adminReturning({ data: { shop: { id: "gid://shopify/Shop/1" }, currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } } });
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin: async () => ({ admin }) })).resolves.toBe(true);
  });

  test("is false when no offline session is stored", async () => {
    class SessionNotFoundError extends Error {}
    const loadAdmin = vi.fn().mockRejectedValue(new SessionNotFoundError("none"));
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin })).resolves.toBe(false);
  });

  test("is false when Shopify rejects the token", async () => {
    const admin = adminReturning(Object.assign(new Error("Unauthorized"), { response: { code: 401 } }));
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin: async () => ({ admin }) })).resolves.toBe(false);
  });

  test("is false when Shopify rejects the refresh of a revoked token", async () => {
    const error = Object.assign(new Error("Bad request"), { response: { code: 400, body: { error: "invalid_subject_token" } } });
    const loadAdmin = vi.fn().mockRejectedValue(error);
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin })).resolves.toBe(false);
  });

  test("throws when a token refresh fails without a clear answer", async () => {
    const loadAdmin = vi.fn().mockRejectedValue(new Response(undefined, { status: 500 }));
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin })).rejects.toBeInstanceOf(Response);
  });

  test("throws when Shopify can't be reached", async () => {
    const loadAdmin = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(shopifyInstallationActive("one.myshopify.com", { loadAdmin })).rejects.toThrow("network down");
  });
});
