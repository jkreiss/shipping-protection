import { expect } from "@playwright/test";
import { assertFixtureCart, syntheticEmail } from "./config.js";

/** @param {import("@playwright/test").Browser} browser @param {Pick<import("@playwright/test").BrowserContextOptions, "viewport" | "isMobile" | "hasTouch">} options */
export async function newBuyerContext(browser, options = {}) {
  const context = await browser.newContext({
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    viewport: options.viewport,
    isMobile: options.isMobile,
    hasTouch: options.hasTouch,
  });
  try {
    expect(
      (await context.cookies()).length,
      "A buyer must not inherit merchant sign-in",
    ).toBe(0);
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** @param {import("@playwright/test").Page} page @param {RegExp} name */
async function input(page, name) {
  let result;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const locator = frame
            .getByRole("textbox", { name })
            .or(frame.getByRole("combobox", { name }))
            .first();
          if (await locator.isVisible()) {
            result = locator;
            return true;
          }
        }
        return false;
      },
      { message: `Checkout field ${name} was not visible.` },
    )
    .toBe(true);
  if (!result) throw new Error(`Missing checkout field ${name}`);
  return /** @type {import("@playwright/test").Locator} */ (result);
}

export class Checkout {
  /** @param {import("@playwright/test").Page} page @param {ReturnType<typeof import("./config.js").readConfig>} config */
  constructor(page, config) {
    this.page = page;
    this.config = config;
  }

  /** @param {string} path @param {Record<string, unknown> | undefined} data */
  async cartRequest(path, data = undefined) {
    // Use the buyer's browser connection and cookies, as the storefront does.
    const response = await this.page.evaluate(
      async ({ path, data }) => {
        const result = await fetch(path, {
          method: data ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: data ? JSON.stringify(data) : undefined,
        });
        return {
          ok: result.ok,
          status: result.status,
          body: await result.json().catch(() => null),
        };
      },
      { path, data },
    );
    expect(
      response.ok,
      `Staging cart request ${path} failed (HTTP ${response.status})`,
    ).toBe(true);
    expect(
      response.body,
      "The staging cart API must return JSON",
    ).not.toBeNull();
    return response.body;
  }

  /** @param {"physical" | "mixed" | "digital"} kind */
  async start(
    kind = "physical",
    runId = "",
    label = "",
    discount = false,
    { enterDetails = true } = {},
  ) {
    const origin = `https://${this.config.shopDomain}`;
    const email = syntheticEmail(runId, label);
    await this.page.goto(`${origin}/cart`);
    if (new URL(this.page.url()).pathname === "/password") {
      if (!this.config.storefrontPassword)
        throw new Error(
          "Set E2E_STOREFRONT_PASSWORD to unlock the staging storefront.",
        );
      try {
        await this.page
          .getByLabel(/password/i)
          .fill(this.config.storefrontPassword);
        await this.page
          .getByRole("button", { name: /^(enter|submit)$/i })
          .click();
        await this.page.waitForURL((url) => url.pathname !== "/password");
      } catch {
        // Locator call logs can contain the password supplied to fill().
        throw new Error(
          "Could not unlock the staging storefront. Check E2E_STOREFRONT_PASSWORD and the password-page controls.",
        );
      }
    }
    expect(
      new URL(this.page.url()).origin,
      "Anonymous cart setup must remain on the staging storefront",
    ).toBe(origin);
    const items =
      kind === "digital"
        ? [{ id: this.config.digitalVariantId, quantity: 1 }]
        : [
            { id: this.config.physicalVariantId, quantity: 1 },
            ...(kind === "mixed"
              ? [{ id: this.config.digitalVariantId, quantity: 1 }]
              : []),
          ];
    // Shopify's native cart link prepares a fresh cart in one navigation.
    // Keep storefront access checks above: cart links cannot bypass its password.
    const cartUrl = new URL(
      `${origin}/cart/${items.map((item) => `${item.id}:${item.quantity}`).join(",")}`,
    );
    cartUrl.searchParams.set("storefront", "true");
    cartUrl.searchParams.set("note", `E2E ${runId} ${label}`);
    cartUrl.searchParams.set("attributes[e2e_run_id]", runId);
    if (discount) cartUrl.searchParams.set("discount", this.config.discountCode);
    await this.page.goto(cartUrl.href);
    expect(new URL(this.page.url()).origin).toBe(origin);
    const cart = await this.cartRequest("/cart.js");
    if (kind !== "digital")
      assertFixtureCart(cart.items, this.config, kind === "mixed");
    else {
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].requires_shipping).toBe(false);
      expect(cart.items[0].original_price).toBe(4000);
    }
    expect(cart.note).toBe(`E2E ${runId} ${label}`);
    expect(cart.attributes.e2e_run_id).toBe(runId);
    if (discount) {
      const discounted = cart;
      expect(
        discounted.items.find(
          (/** @type {{variant_id: number}} */ item) =>
            String(item.variant_id) === this.config.physicalVariantId,
        )?.final_price,
        "The fixture discount must take exactly 10% off the physical merchandise",
      ).toBe(9000);
      if (kind === "mixed")
        expect(
          discounted.items.find(
            (/** @type {{variant_id: number}} */ item) =>
              String(item.variant_id) === this.config.digitalVariantId,
          )?.final_price,
        ).toBe(4000);
    }
    await this.page.goto(`${origin}/checkout`);
    if (!enterDetails) {
      await input(this.page, /Email(?: or mobile phone number)?/i);
      await this.summary();
      return email;
    }
    await (
      await input(this.page, /Email(?: or mobile phone number)?/i)
    ).fill(email);
    if (kind !== "digital") await this.address();
    await expect(
      this.page.getByRole("button", { name: /Pay now|Complete order/i }),
    ).toBeVisible();
    await this.summary();
    return email;
  }
  async address() {
    const address = this.config.shippingAddress;
    const country = this.page
      .getByRole("combobox", { name: /Country\/Region|Country|Region/i })
      .first();
    await expect(country).toBeVisible();
    await country.selectOption(address.country);
    await (await input(this.page, /First name/i)).fill("E2E");
    await (await input(this.page, /Last name/i)).fill("Staging Test");
    await (await input(this.page, /^Address$/i)).fill(address.street);
    await (await input(this.page, /City|Suburb/i)).fill(address.city);
    await this.page
      .getByRole("combobox", { name: /State|Province/i })
      .first()
      .selectOption(address.state);
    await (
      await input(this.page, /Postal code|Postcode|ZIP code/i)
    ).fill(address.postalCode);
    const phone = this.page.getByRole("textbox", { name: /^Phone/ }).first();
    if (await phone.isVisible()) await phone.fill(address.phone);
  }
  async summary() {
    const expand = this.page.getByRole("button", {
      name: /Show order summary|^Order summary.*Total/i,
      expanded: false,
    }).first();
    if (await expand.isVisible()) await expand.click();
  }
  offer() {
    return this.page.getByRole("checkbox", {
      name: /^Add shipping protection for /i,
    });
  }
  async expectOffer(amount = 1, checked = false) {
    await expect(this.offer()).toBeVisible();
    await expect(this.offer()).toHaveAccessibleName(
      new RegExp(
        `^Add shipping protection for [^\\d]*${amount.toFixed(2).replace(".", "\\.")}(?:\\D|$)`,
        "i",
      ),
    );
    if (checked) await expect(this.offer()).toBeChecked();
    else await expect(this.offer()).not.toBeChecked();
  }
  async expectNoOffer() {
    // A null extension render has no readiness marker. Observe through startup.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      expect(await this.offer().count(), "Digital checkout must not offer protection").toBe(0);
      await this.page.waitForTimeout(100);
    }
  }
  async selectProtection(checked = true) {
    await expect(this.offer()).toBeEnabled();
    // Remote UI updates checked state after the asynchronous cart mutation.
    if ((await this.offer().isChecked()) !== checked)
      await this.offer().click();
    if (checked) await expect(this.offer()).toBeChecked();
    else await expect(this.offer()).not.toBeChecked();
    await expect(this.offer()).toBeEnabled();
  }
  protectionRow() {
    return this.page
      .getByRole("row")
      .filter({ has: this.page.getByText(/^Shipping protection$/i) });
  }
  async expectProtectionLine(amount = 1) {
    await this.summary();
    // Shopify's mobile checkout renders the order summary twice, so check
    // that each cart table lists the protection line exactly once.
    const tables = this.page
      .getByRole("table", { name: "Shopping cart" })
      .filter({ has: this.page.getByText(/^Shipping protection$/i) });
    await expect(tables).not.toHaveCount(0);
    for (const table of await tables.all()) {
      const rows = table
        .getByRole("row")
        .filter({ has: this.page.getByText(/^Shipping protection$/i) });
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(
        new RegExp(`(?:^|\\D)${amount.toFixed(2).replace(".", "\\.")}(?:\\D|$)`),
      );
    }
  }
  async expectNoProtectionLine() {
    await this.summary();
    await expect(this.protectionRow()).toHaveCount(0);
  }
  async pay() {
    // Never use real card data, even when the staging store has another payment option.
    const number =
      this.config.paymentGateway === "bogus" ? "1" : "4242424242424242";
    await (await input(this.page, /Card number/i)).fill(number);
    await (
      await input(this.page, /Name on card/i)
    ).fill(this.config.testGatewayCardName);
    await (
      await input(this.page, /Expiration date|Expiry date/i)
    ).fill(`12${String(new Date().getFullYear() + 3).slice(-2)}`);
    await (await input(this.page, /Security code|CVV|CVC/i)).fill("111");
    const pay = this.page.getByRole("button", {
      name: /Pay now|Complete order/i,
    });
    await expect(pay).toBeEnabled();
    // A single submission: retries are disabled so a timeout cannot create another order.
    await pay.click();
    await expect(
      this.page
        .getByText(/Your order is confirmed|Thank you|Order confirmed/i)
        .first(),
    ).toBeVisible({ timeout: 90_000 });
  }
}
