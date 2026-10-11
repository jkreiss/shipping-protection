import { describe, expect, test } from "vitest";
import {
  claimsPageAvailable,
  IMPLEMENTED_CAPABILITIES,
  observedShopifyCapabilities,
  resolveConfiguration,
} from "./resolve-configuration";

const enabled = {
  protectionEnabled: true,
  protectionRateEditable: true,
  attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
  stolenCoverageEnabled: true,
  lostCoverageEnabled: true,
  damagedCoverageEnabled: true,
  returnsEnabled: true,
  freeReturnsEnabled: true,
  emailClaimIntakeEnabled: true,
  formClaimIntakeEnabled: true,
  adminClaimIntakeEnabled: true,
  autoApprovalEnabled: true,
};

const supported = { checkoutUiSupported: true, cartTransformUpdateSupported: true };

describe("merchant configuration resolution", () => {
  test("enables the working strategy on a capable Plus shop", () => {
    const capabilities = observedShopifyCapabilities({
      plan: { shopifyPlus: true },
      features: { cartTransform: { eligibleOperations: { updateOperation: true } } },
    });
    expect(resolveConfiguration(enabled, capabilities, true)).toMatchObject({
      strategy: "CHECKOUT_UI_CART_TRANSFORM",
      protectionEnabled: true,
      protectionRateEditable: true,
      merchantActivationRequired: true,
      returnsEnabled: false,
      freeReturnsEnabled: false,
      claimIntakeEnabled: false,
      autoApprovalEnabled: false,
    });
  });

  test("keeps a rate restriction independent of checkout readiness", () => {
    const state = resolveConfiguration({ ...enabled, protectionRateEditable: false }, supported, true);
    expect(state.protectionEnabled).toBe(true);
    expect(state.protectionRateEditable).toBe(false);
    expect(resolveConfiguration(undefined, supported, false).protectionRateEditable).toBe(false);
  });

  test("falls back when a shop lacks Plus even if line updates are eligible", () => {
    const capabilities = observedShopifyCapabilities({
      plan: { shopifyPlus: false, partnerDevelopment: true },
      features: { cartTransform: { eligibleOperations: { updateOperation: true } } },
    });
    expect(resolveConfiguration(enabled, capabilities, true)).toMatchObject({
      strategy: "NONE",
      reasons: ["Checkout UI blocks require Shopify Plus."],
    });
  });

  test("falls back when price updates are unavailable on a Plus shop", () => {
    expect(resolveConfiguration(enabled, {
      checkoutUiSupported: true, cartTransformUpdateSupported: false,
    }, true).strategy).toBe("NONE");
  });

  test("keeps a newly installed or disabled merchant off", () => {
    expect(resolveConfiguration({ ...enabled, protectionEnabled: false }, supported, true))
      .toMatchObject({ strategy: "NONE", protectionEnabled: false });
    expect(resolveConfiguration({ protectionEnabled: false, attachmentStrategy: "NONE" }, {
      checkoutUiSupported: false, cartTransformUpdateSupported: false,
    }, false).reasons).toHaveLength(2);
  });

  test("does not expose an unbuilt theme strategy or a broken setup", () => {
    expect(resolveConfiguration({ ...enabled, attachmentStrategy: "THEME_CART" }, supported, true))
      .toMatchObject({ strategy: "NONE", reasons: ["Theme cart attachment is not implemented."] });
    expect(resolveConfiguration(enabled, supported, false).strategy).toBe("NONE");
  });
});

describe("claimsPageAvailable", () => {
  test("hides the page until claim intake or returns are implemented", () => {
    expect(claimsPageAvailable(IMPLEMENTED_CAPABILITIES)).toBe(false);
    expect(claimsPageAvailable({ claimIntake: true, returns: false })).toBe(true);
    expect(claimsPageAvailable({ claimIntake: false, returns: true })).toBe(true);
  });
});
