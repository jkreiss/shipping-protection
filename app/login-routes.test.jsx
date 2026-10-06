/** @jsxImportSource react */
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ login: vi.fn() }));

// Tests compile JSX for Preact; render the route with React, as the app does.
vi.mock("preact/jsx-runtime", async () => ({
  ...(await vi.importActual("react/jsx-runtime")),
  ...(await vi.importActual("react/jsx-dev-runtime")),
}));
vi.mock("./shopify.server", () => ({ login: mocks.login }));

import { renderToStaticMarkup } from "react-dom/server";
import Landing, { loader as landingLoader } from "./routes/_index/route";
import { loader as loginLoader } from "./routes/auth.login/route";

async function thrown(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the loader to throw.");
}

beforeEach(() => {
  vi.clearAllMocks();
});

// App Store requirement 2.3.1: merchants never type a shop domain.
describe("app landing page", () => {
  test("sends a request from Shopify into the app", async () => {
    const response = await thrown(landingLoader({
      request: new Request("https://app.example/?shop=one.myshopify.com&host=abc"),
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/app?shop=one.myshopify.com&host=abc");
  });

  test("asks for no shop domain", () => {
    const html = renderToStaticMarkup(<Landing />);

    expect(html).not.toMatch(/<(form|input)\b/);
    expect(html).toContain("Open this app from your Shopify admin.");
  });
});

describe("login route", () => {
  test("lets Shopify's install redirect through", async () => {
    const install = new Response(null, { status: 302, headers: { Location: "https://admin.shopify.com/store/one/oauth/install" } });
    mocks.login.mockRejectedValue(install);

    const response = await thrown(loginLoader({
      request: new Request("https://app.example/auth/login?shop=one.myshopify.com"),
    }));

    expect(response).toBe(install);
  });

  test.each([
    ["https://app.example/auth/login", {}],
    ["https://app.example/auth/login?shop=not%20a%20shop", { shop: "INVALID_SHOP" }],
  ])("sends %s to the landing page instead of a shop domain form", async (url, loginResult) => {
    mocks.login.mockResolvedValue(loginResult);

    const response = await thrown(loginLoader({ request: new Request(url) }));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });
});
