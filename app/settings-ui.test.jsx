/** @jsxImportSource react */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ state: null }));
vi.mock("preact/jsx-runtime", async () => ({
  ...(await vi.importActual("react/jsx-runtime")),
  ...(await vi.importActual("react/jsx-dev-runtime")),
}));
vi.mock("react-router", () => ({
  useLoaderData: () => mocks.state,
  useFetcher: () => ({ state: "idle", Form: "form" }),
}));
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
}));
vi.mock("./shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("./shipping-protection.server", () => ({
  activatePricingRule: vi.fn(),
  readShippingProtectionState: vi.fn(),
  setupShippingProtection: vi.fn(),
}));

import Settings from "./routes/app.settings";

function render() {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Settings />);
  return container;
}

beforeEach(() => {
  mocks.state = {
    configuration: {
      protectionEnabled: true,
      protectionRateEditable: true,
      reasons: [],
    },
    configuredStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    capabilities: {
      checkoutUiSupported: true,
      cartTransformUpdateSupported: true,
    },
    checks: [{ id: "setup", ok: true }],
    product: { id: "gid://shopify/Product/1", title: "Shipping Protection" },
    pricing: { ruleId: "rule-1", rateBasisPoints: 40, percentage: "0.4%" },
  };
});

describe("settings controls", () => {
  test("shows a rate form only when the store can edit its rate", () => {
    expect(
      render().querySelector('s-number-field[name="ratePercent"]'),
    ).not.toBeNull();
    mocks.state.configuration.protectionRateEditable = false;
    const locked = render();
    expect(
      locked.querySelector('s-number-field[name="ratePercent"]'),
    ).toBeNull();
    expect(locked.querySelector('input[value="update-rate"]')).toBeNull();
    expect(
      locked.querySelector('s-section[heading="Pricing"]').textContent,
    ).toContain("0.4%");
  });

  test("hides setup updates when ready and offers them when a check fails", () => {
    expect(
      render().querySelector('s-section[heading="Protection status"] s-button'),
    ).toBeNull();
    mocks.state.configuration.protectionEnabled = false;
    mocks.state.checks = [
      { id: "setup", ok: false, label: "Setup needs attention" },
    ];
    expect(render().textContent).toContain("Update protection setup");
  });

  test("offers first-time setup for a newly installed store", () => {
    mocks.state.configuration.protectionEnabled = false;
    mocks.state.configuredStrategy = "NONE";
    mocks.state.product = null;
    mocks.state.pricing = null;
    expect(render().textContent).toContain("Set up protection");
  });
});
