/** @jsxImportSource react */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ state: null, saving: false }));
vi.mock("preact/jsx-runtime", async () => ({
  ...(await vi.importActual("react/jsx-runtime")),
  ...(await vi.importActual("react/jsx-dev-runtime")),
}));
vi.mock("react-router", () => ({
  useLoaderData: () => mocks.state,
  useFetcher: () => ({
    state: mocks.saving ? "submitting" : "idle",
    formMethod: "POST",
    Form: "form",
  }),
}));
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
}));
vi.mock("./shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("./shipping-protection.server", () => ({
  activatePricingRule: vi.fn(),
  disableShippingProtection: vi.fn(),
  readShippingProtectionState: vi.fn(),
  setupShippingProtection: vi.fn(),
  updateCheckoutOffer: vi.fn(),
}));
vi.mock("./merchant/checkout-offer.server", () => ({
  updateCheckoutOffer: vi.fn(),
}));

import Settings from "./routes/app.settings";

function render() {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<Settings />);
  return container;
}

beforeEach(() => {
  mocks.saving = false;
  mocks.state = {
    protectionOff: false,
    configuration: {
      protectionEnabled: true,
      protectionRateEditable: true,
      protectionPreselectionEditable: true,
      protectionCopyEditable: true,
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
  test("does not expose preselection even when the shared database setting is enabled", () => {
    mocks.state.checkoutOffer = {
      preselected: true,
      checkboxLabel: null,
      supportingText: null,
    };
    const settings = render();
    expect(settings.querySelector('s-switch[name="preselected"]')).toBeNull();
    expect(
      settings.querySelector('input[value="update-preselection"]'),
    ).toBeNull();
    expect(settings.textContent).not.toContain("Default selection");
  });
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
      locked.querySelector('s-section[heading="Checkout offer"]').textContent,
    ).toContain("0.4%");
  });

  test("groups offer controls and locks each editor independently", () => {
    const offer = render().querySelector('s-section[heading="Checkout offer"]');
    expect(
      offer.querySelector('s-text-field[name="checkboxLabel"]'),
    ).not.toBeNull();
    expect(
      offer.querySelector('s-number-field[name="ratePercent"]'),
    ).not.toBeNull();
    mocks.state.configuration.protectionCopyEditable = false;
    expect(
      render().querySelector('s-text-field[name="checkboxLabel"]'),
    ).toBeNull();
    expect(
      render().querySelector('s-number-field[name="ratePercent"]'),
    ).not.toBeNull();
  });

  test("hides setup updates when ready and offers them when a check fails", () => {
    const status = render().querySelector(
      's-section[heading="Protection status"]',
    );
    expect(status.textContent).not.toContain("Update protection setup");
    expect(status.textContent).not.toContain("Set up protection");
    expect(status.querySelector('input[value="disable"]')).not.toBeNull();
    expect(status.querySelector('s-button[type="submit"]').textContent).toBe(
      "Turn off shipping protection",
    );
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
    expect(render().querySelector('input[value="disable"]')).toBeNull();
  });

  test("shows Off and a restore button without treating disabled settings as broken", () => {
    mocks.state.protectionOff = true;
    mocks.state.configuration.protectionEnabled = false;
    mocks.state.checks = [
      {
        id: "checkoutConfig",
        ok: false,
        label: "Checkout configuration is enabled",
      },
      {
        id: "transformConfig",
        ok: false,
        label: "Cart Transform pricing configuration is enabled",
      },
    ];
    const page = render();
    const status = page.querySelector('s-section[heading="Protection status"]');

    expect(status.querySelector("s-badge").textContent).toBe("Off");
    expect(status.textContent).not.toContain("Needs attention");
    expect(status.textContent).not.toContain("Update protection setup");
    expect(status.querySelector('input[value="enable"]')).not.toBeNull();
    expect(status.querySelector('s-button[type="submit"]').textContent).toBe(
      "Turn on shipping protection",
    );
    expect(
      page
        .querySelector('s-number-field[name="ratePercent"]')
        .getAttribute("value"),
    ).toBe("0.4");
    expect(
      page
        .querySelector('input[value="update-rate"]')
        .closest("form")
        .querySelector("s-button")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  test("keeps real setup failures visible while protection is off", () => {
    mocks.state.protectionOff = true;
    mocks.state.configuration.protectionEnabled = false;
    mocks.state.checks = [
      { id: "product", ok: false, label: "Shipping Protection product exists" },
    ];
    expect(render().textContent).toContain("Needs attention");
  });

  test("disables all settings actions while a change is saving", () => {
    mocks.saving = true;
    expect(
      [...render().querySelectorAll("s-button")].every((button) =>
        button.hasAttribute("disabled"),
      ),
    ).toBe(true);
  });
});
