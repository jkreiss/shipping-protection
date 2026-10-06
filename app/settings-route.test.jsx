import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activatePricingRule: vi.fn(),
  disableShippingProtection: vi.fn(),
  readShippingProtectionState: vi.fn(),
  setupShippingProtection: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("./shopify.server", () => ({
  authenticate: { admin: async () => ({ admin: {}, session: { shop: "one.myshopify.com" } }) },
}));
vi.mock("./shipping-protection.server", () => ({
  activatePricingRule: mocks.activatePricingRule,
  disableShippingProtection: mocks.disableShippingProtection,
  readShippingProtectionState: mocks.readShippingProtectionState,
  setupShippingProtection: mocks.setupShippingProtection,
}));
vi.mock("./observability.server", () => ({ reportFailure: mocks.reportFailure }));

import { action } from "./routes/app.settings";
import { UserFacingError } from "./user-facing-error";

function submit(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return action({ request: new Request("https://app.example/app/settings", { method: "POST", body }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readShippingProtectionState.mockResolvedValue({ ready: true });
});

describe("settings errors", () => {
  test("shows a message written for merchants", async () => {
    mocks.setupShippingProtection.mockRejectedValue(new UserFacingError("Set up protection before changing the rate."));
    const result = await submit({ intent: "setup" });
    expect(result.error).toBe("Set up protection before changing the rate.");
    expect(mocks.reportFailure).not.toHaveBeenCalled();
  });

  test("explains an invalid rate without calling Shopify", async () => {
    const result = await submit({ intent: "update-rate", ratePercent: "1.234" });
    expect(result.error).toContain("at most two decimal places");
    expect(mocks.activatePricingRule).not.toHaveBeenCalled();
  });

  test("hides internal error details and reports them", async () => {
    const internal = new Error("Field 'cartTransformCreate' doesn't exist; postgres://user:pw@host");
    mocks.setupShippingProtection.mockRejectedValue(internal);
    const result = await submit({ intent: "setup" });
    expect(result.error).not.toContain("cartTransformCreate");
    expect(result.error).toContain("weren't saved");
    expect(mocks.reportFailure).toHaveBeenCalledWith("settings_action_failed", internal, {
      shop: "one.myshopify.com", intent: "setup",
    });
  });
});

describe("protection on/off settings", () => {
  test("turns protection off for the authenticated shop, ignoring a submitted shop", async () => {
    const state = { protectionOff: true };
    mocks.disableShippingProtection.mockResolvedValue(state);

    const result = await submit({ intent: "disable", shop: "two.myshopify.com" });

    expect(result).toMatchObject({ state, success: expect.stringContaining("turned off") });
    expect(mocks.disableShippingProtection).toHaveBeenCalledWith({}, "one.myshopify.com");
    expect(mocks.setupShippingProtection).not.toHaveBeenCalled();
    expect(mocks.activatePricingRule).not.toHaveBeenCalled();
  });

  test("turns protection back on through the existing checked setup flow", async () => {
    const state = { protectionOff: false };
    mocks.setupShippingProtection.mockResolvedValue(state);

    const result = await submit({ intent: "enable" });

    expect(result).toMatchObject({ state, success: expect.stringContaining("turned on") });
    expect(mocks.setupShippingProtection).toHaveBeenCalledWith({}, "one.myshopify.com");
    expect(mocks.activatePricingRule).not.toHaveBeenCalled();
  });

  test("reports a failed turn-off without claiming success", async () => {
    mocks.disableShippingProtection.mockRejectedValue(new Error("Shopify unavailable"));
    mocks.readShippingProtectionState.mockResolvedValue({ protectionOff: false });

    const result = await submit({ intent: "disable" });

    expect(result.success).toBeUndefined();
    expect(result.error).toContain("turning off");
    expect(result.state.protectionOff).toBe(false);
  });
});
