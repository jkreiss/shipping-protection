import { test, expect } from "./support/fixtures.js";

test.beforeEach(async ({ staging }) => {
  await staging.merchant.setRate("1");
});

test("protection appears and can be selected before an address is entered", async ({
  checkout,
  staging,
}) => {
  await checkout.start("physical", staging.runId, "before-address", false, {
    enterDetails: false,
  });
  const address = checkout.page.getByRole("textbox", {
    name: /^Address$/i,
  });
  await expect(address).toBeEmpty();
  await checkout.expectOffer(1, false);
  await checkout.selectProtection(true);
  await checkout.expectOffer(1, true);
  await checkout.expectProtectionLine(1);
  await expect(address).toBeEmpty();
  await checkout.selectProtection(false);
  await checkout.expectNoProtectionLine();
});

test("protection starts unselected, adds one priced line, and can be removed", async ({
  checkout,
  staging,
}) => {
  await checkout.start("physical", staging.runId, "selection");
  await checkout.expectOffer(1, false);
  await checkout.selectProtection(true);
  await checkout.expectOffer(1, true);
  await checkout.expectProtectionLine(1);
  await checkout.selectProtection(false);
  await checkout.expectNoProtectionLine();
  await checkout.expectOffer(1, false);
});

test("digital merchandise does not increase the shippable protection fee", async ({
  checkout,
  staging,
}) => {
  await checkout.start("mixed", staging.runId, "mixed");
  await checkout.expectOffer(1, false);
  await checkout.selectProtection(true);
  await checkout.expectProtectionLine(1);
});

test("digital-only checkout does not offer protection", async ({
  checkout,
  staging,
}) => {
  await checkout.start("digital", staging.runId, "digital");
  await checkout.expectNoOffer();
  await checkout.expectNoProtectionLine();
});

test("a merchandise discount preserves the pre-discount protection fee", async ({
  checkout,
  staging,
}) => {
  await checkout.start("physical", staging.runId, "discount", true);
  await expect(
    checkout.page
      .getByText(staging.config.discountCode, { exact: false })
      .first(),
  ).toBeVisible();
  await checkout.expectOffer(1, false);
  await checkout.selectProtection(true);
  await checkout.expectProtectionLine(1);
});
