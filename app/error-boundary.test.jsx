/** @jsxImportSource react */
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  error: undefined,
  loaderData: { apiKey: "key" },
  location: { pathname: "/app/settings", search: "?shop=one.myshopify.com&host=abc" },
}));

// Tests compile JSX for Preact; render the routes with React, as the app does.
vi.mock("preact/jsx-runtime", async () => ({
  ...(await vi.importActual("react/jsx-runtime")),
  ...(await vi.importActual("react/jsx-dev-runtime")),
}));
vi.mock("react-router", async () => ({
  ...(await vi.importActual("react-router")),
  useRouteError: () => mocks.error,
  useRouteLoaderData: () => mocks.loaderData,
  useLocation: () => mocks.location,
}));
// Shopify's provider loads its own router copy in tests; show only its props.
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  // eslint-disable-next-line react/prop-types
  AppProvider: ({ embedded, apiKey, children }) => (
    <div data-embedded={String(embedded)} data-api-key={apiKey}>
      {children}
    </div>
  ),
}));
vi.mock("./shopify.server", () => ({ authenticate: { admin: vi.fn() } }));

import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary as AppBoundary } from "./routes/app";
import { ErrorBoundary as RootBoundary } from "./root";

// Shopify's boundary recognises a thrown route response by its class name.
class ErrorResponseImpl {
  constructor(status, statusText, data) {
    Object.assign(this, { status, statusText, data, internal: false });
  }
}

beforeEach(() => {
  mocks.loaderData = { apiKey: "key" };
});

describe("app error boundary", () => {
  test("shows a retry page, not the error, for a failed Shopify request", () => {
    mocks.error = new Error("Throttled: cost 1002 of 1000 for gid://shopify/Shop/1");

    const html = renderToStaticMarkup(<AppBoundary />);

    expect(html).toContain("This page couldn&#x27;t load");
    expect(html).toContain("Reload");
    expect(html).toContain("<s-app-nav>");
    expect(html).toContain('data-embedded="true"');
    expect(html).not.toContain("Throttled");
    expect(html).not.toContain("gid://");
  });

  test("still renders without an API key when the app loader failed", () => {
    mocks.error = new Error("boom");
    mocks.loaderData = undefined;

    const html = renderToStaticMarkup(<AppBoundary />);

    expect(html).toContain("This page couldn&#x27;t load");
    expect(html).toContain('data-embedded="false"');
  });

  test("leaves responses Shopify must handle to Shopify's boundary", () => {
    mocks.error = new ErrorResponseImpl(410, "Gone", "<p>Shopify handled</p>");

    const html = renderToStaticMarkup(<AppBoundary />);

    expect(html).toContain("<p>Shopify handled</p>");
    expect(html).not.toContain("This page couldn&#x27;t load");
  });
});

test("a thrown 5xx response gets the retry page, not Shopify's boundary", () => {
  mocks.error = new ErrorResponseImpl(500, "Internal Server Error", undefined);
  mocks.loaderData = { apiKey: "key" };

  const html = renderToStaticMarkup(<AppBoundary />);

  expect(html).toContain("This page couldn&#x27;t load");
});

describe("root error boundary", () => {
  test("renders a minimal document without the error", () => {
    mocks.error = new Error("secret detail");

    const html = renderToStaticMarkup(<RootBoundary />);

    expect(html).toContain("<html");
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("secret detail");
    // Retrying keeps the shop and host that authentication needs.
    expect(html).toContain('href="/app/settings?shop=one.myshopify.com&amp;host=abc"');
  });

  test("says a missing page was not found and links back to the app", () => {
    mocks.error = new ErrorResponseImpl(404, "Not Found", null);

    const html = renderToStaticMarkup(<RootBoundary />);

    expect(html).toContain("Page not found");
    expect(html).not.toContain("Try again in a moment");
    expect(html).toContain('href="/app?shop=one.myshopify.com&amp;host=abc"');
  });
});
