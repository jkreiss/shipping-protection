/** @jsxImportSource react */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ data: null }));
vi.mock("preact/jsx-runtime", async () => ({
  ...(await vi.importActual("react/jsx-runtime")),
  ...(await vi.importActual("react/jsx-dev-runtime")),
}));
vi.mock("react-router", () => ({
  useLoaderData: () => mocks.data,
  useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("./shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("./analytics.server", () => ({ readOverview: vi.fn() }));
vi.mock("./shipping-protection.server", () => ({ readShippingProtectionState: vi.fn() }));
vi.mock("./claims/claims.server", () => ({ readClaimsOverview: vi.fn() }));
import Overview from "./routes/app.overview";
import Claims, { loader as claimsLoader } from "./routes/app.claims";
import { authenticate } from "./shopify.server";
import { readClaimsOverview } from "./claims/claims.server";

const DateFormatter = Intl.DateTimeFormat;
const NumberFormatter = Intl.NumberFormat;
function hostDefaults(locale, timeZone) {
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation((language, options) =>
    new DateFormatter(language ?? locale, { timeZone, ...options }));
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (language, options) {
    return new DateFormatter(language ?? locale, { timeZone, ...options, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(this);
  });
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (language, options) {
    return new DateFormatter(language ?? locale, { timeZone, ...options }).format(this);
  });
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (language, options) {
    return new NumberFormatter(language ?? locale, options).format(this.valueOf());
  });
  vi.spyOn(Intl, "NumberFormat").mockImplementation((language, options) =>
    new NumberFormatter(language ?? locale, options));
}
afterEach(() => { vi.restoreAllMocks(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

async function verifyHydration(Component) {
  hostDefaults("en-US", "UTC");
  const server = renderToString(<Component />);
  vi.restoreAllMocks();
  hostDefaults("de-DE", "Asia/Tokyo");
  expect(renderToString(<Component />)).toBe(server);
  const container = document.createElement("div");
  container.innerHTML = server;
  const errors = [];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root;
  await act(async () => { root = hydrateRoot(container, <Component />, { onRecoverableError: (error) => errors.push(error) }); });
  expect(errors).toEqual([]);
  await act(async () => root.unmount());
  return server;
}

test("Overview dates and money survive different server and browser defaults", async () => {
  mocks.data = {
    shopDomain: "one.myshopify.com", protection: { active: true, rate: "0.4%" },
    metrics: {
      currencyCode: "USD", timeZone: "America/Los_Angeles", revenue: "1234.50", claimsPaid: "0", refunds: "0", netRevenue: "1234.50",
      protectedOrders: 1234, eligibleOrders: 1234, attachRate: 100, hiddenTestOrders: 0, includeTest: false,
      notices: {}, sync: { complete: true, behind: false, reconciledThrough: "2026-03-09T00:30:00Z" },
      trend: [{ date: "2026-03-07", revenue: "0" }, { date: "2026-03-08", revenue: "0" }, { date: "2026-03-09", revenue: "1234.50" }],
      recentActivity: [{ id: "p1", kind: "PURCHASED", at: "2026-03-09T00:30:00Z", amount: "1234.50", currencyCode: "USD", orderName: "#1001", shopifyOrderId: "gid://shopify/Order/1" }],
    },
  };
  const html = await verifyHydration(Overview);
  expect(html).toContain("$1,234.50");
  expect(html).toContain("<s-heading>1,234</s-heading>");
  expect(html).toContain("Mar 8");
  expect(html).toContain("Mar 9"); // date-only chart label retains its calendar day
  expect(html).toContain("3/8/2026, 5:30:00 PM");
});

test.each([
  ["2026-03-08T07:30:00Z", "3/7/2026"], // before DST
  ["2026-03-09T07:30:00Z", "3/9/2026"], // after DST: offset changes
])("claim submitted date uses merchant timezone at %s", async (submittedAt, expected) => {
  mocks.data = { timeZone: "America/Los_Angeles", claimIntakeEnabled: false, returnsEnabled: false,
    claims: [{ id: "c1", type: "LOST", status: "SUBMITTED", submittedAt, orderName: "#1001", shopifyOrderId: "gid://shopify/Order/1" }] };
  expect(await verifyHydration(Claims)).toContain(expected);
});


test("Claims loader passes the authenticated Admin client and tenant", async () => {
  const admin = { graphql: vi.fn() };
  const request = new Request("https://app.example/app/claims?shop=untrusted.myshopify.com");
  authenticate.admin.mockResolvedValue({ admin, session: { shop: "trusted.myshopify.com" } });
  readClaimsOverview.mockResolvedValue({ claims: [], timeZone: "America/New_York" });
  await expect(claimsLoader({ request })).resolves.toMatchObject({ timeZone: "America/New_York" });
  expect(readClaimsOverview).toHaveBeenCalledWith(admin, "trusted.myshopify.com");
});
