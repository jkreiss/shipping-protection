import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import {
  assertAdminUrl,
  assertAppIdentity,
  assertRefundTotal,
  AUTH_DIRECTORY,
  INGESTION_TIMEOUT,
} from "./config.js";
import { isStagingAdmin, openAuthBrowser } from "./auth-browser.js";

/** @typedef {ReturnType<typeof import("./config.js").readConfig>} Config */
/** @typedef {{revenue: number, protectedOrders: number, eligibleOrders: number, netRevenue: number}} Metrics */

/** @param {import("@playwright/test").Page} page @param {Config} config */
export async function stagingFrame(page, config, timeout = 45_000) {
  await expect
    .poll(
      () =>
        page
          .frames()
          .find((frame) => frame.url().startsWith(`${config.appOrigin}/`)),
      {
        timeout,
        message:
          "Open the staging app; if sign-in expired, run npm run test:e2e:auth.",
      },
    )
    .toBeTruthy();
  const frame = page
    .frames()
    .find((frame) => frame.url().startsWith(`${config.appOrigin}/`));
  if (!frame) throw new Error("Staging app frame was not found.");
  await expect
    .poll(() =>
      frame.evaluate(() => {
        const bridge =
          /** @type {Window & {shopify?: {config?: {apiKey?: string}}}} */ (
            window
          ).shopify;
        return (
          bridge?.config?.apiKey ??
          document
            .querySelector('meta[name="shopify-api-key"]')
            ?.getAttribute("content") ??
          null
        );
      }),
    )
    .toBe(config.clientId);
  const apiKey = await frame.evaluate(
    () =>
      /** @type {Window & {shopify?: {config?: {apiKey?: string}}}} */ (window)
        .shopify?.config?.apiKey ??
      document
        .querySelector('meta[name="shopify-api-key"]')
        ?.getAttribute("content") ??
      null,
  );
  assertAppIdentity(config, { frameUrl: frame.url(), apiKey });
  return frame;
}

/** @param {import("@playwright/test").Browser} browser @param {Config} config */
export async function openMerchant(browser, config) {
  let metadata;
  try {
    metadata = JSON.parse(
      readFileSync(new URL("metadata.json", AUTH_DIRECTORY), "utf8"),
    );
  } catch {
    throw new Error(
      "No saved staging sign-in. Run npm run test:e2e:auth first.",
    );
  }
  if (
    metadata.shopDomain !== config.shopDomain ||
    metadata.appOrigin !== config.appOrigin ||
    metadata.clientId !== config.clientId
  )
    throw new Error(
      "Saved sign-in belongs to a different store/app. Run npm run test:e2e:auth again.",
    );
  assertAdminUrl(metadata.adminAppUrl);
  const profile =
    metadata.browserMode === "regular-chrome"
      ? await openAuthBrowser(metadata.adminAppUrl, true)
      : undefined;
  const context =
    profile?.context ??
    (await browser.newContext({
      storageState: new URL("shopify.json", AUTH_DIRECTORY).pathname,
      locale: "en-AU",
    }));
  const close = profile?.close ?? (() => context.close());
  try {
    const page = profile
      ? (context.pages().find((candidate) => isStagingAdmin(candidate.url())) ??
        (await context.newPage()))
      : await context.newPage();
    const merchant = new Merchant(page, {
      ...config,
      adminAppUrl: metadata.adminAppUrl,
    });
    await merchant.overview();
    return { context, merchant, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export class Merchant {
  /** @param {import("@playwright/test").Page} page @param {Config} config */
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.frame = page.mainFrame();
    this.storeAdmin = "https://admin.shopify.com/store/app-test-kwvgodpl";
  }

  async navigate(screen = "overview", includeTest = false) {
    await this.page.goto(
      `${this.config.adminAppUrl}/app/${screen}${includeTest ? "?test=1" : ""}`,
    );
    this.frame = await stagingFrame(this.page, this.config);
    await expect(this.frame.locator("s-page")).toHaveAttribute(
      "heading",
      screen === "settings" ? "Settings" : "Overview",
    );
  }
  async settings() {
    await this.navigate("settings");
  }
  async overview(includeTest = false) {
    await this.navigate("overview", includeTest);
  }
  async rate() {
    const field = this.frame.getByRole("spinbutton", {
      name: "Protection rate",
      exact: true,
    });
    await expect(field).toBeVisible();
    return String(Number(await field.inputValue()));
  }
  async setRate(percent = "1") {
    await this.settings();
    if ((await this.rate()) === String(Number(percent))) return;
    await this.frame
      .getByRole("spinbutton", { name: "Protection rate", exact: true })
      .fill(percent);
    const [saved] = await Promise.all([
      this.page.waitForResponse(
        (response) => {
          const request = response.request();
          const url = new URL(response.url());
          return (
            url.origin === this.config.appOrigin &&
            request.method() === "POST" &&
            /^\/app\/settings(?:\.data)?$/.test(url.pathname)
          );
        },
        { timeout: 45_000 },
      ),
      this.frame
        .getByRole("button", { name: "Save rate", exact: true })
        .click(),
    ]);
    expect(saved.ok(), "The staging rate request must finish successfully").toBe(
      true,
    );
    await this.settings();
    expect(await this.rate()).toBe(String(Number(percent)));
  }
  async invalidRate() {
    const field = this.frame.getByRole("spinbutton", {
      name: "Protection rate",
      exact: true,
    });
    await field.fill("0");
    await this.frame
      .getByRole("button", { name: "Save rate", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await field.evaluate(
            (element) =>
              element instanceof HTMLInputElement && !element.validity.valid,
          )) ||
          (await this.frame.locator('s-banner[tone="critical"]').isVisible()),
      )
      .toBe(true);
    await this.settings();
  }
  async healthy() {
    await this.settings();
    await expect(
      this.frame.getByRole("button", { name: "Save rate", exact: true }),
    ).toBeEnabled();
    await expect(this.frame.getByText("Active", { exact: true })).toBeVisible();
    return this.rate();
  }
  async verifyTestGateway() {
    await this.page.goto(`${this.storeAdmin}/settings/payments`);
    if (this.config.paymentGateway === "bogus") {
      const gateway = this.page
        .getByText(/Bogus Gateway|Test payment gateway/i)
        .first();
      await expect(gateway).toBeVisible();
      const cardName = /Bogus/i.test(await gateway.innerText())
        ? "Bogus Gateway"
        : "Test payment gateway";
      await this.settings();
      return cardName;
    } else {
      await expect(
        this.page.getByText("Shopify Payments", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        this.page
          .getByText(
            /Test mode is on|Test mode enabled|in test mode|Test mode is active/i,
          )
          .first(),
      ).toBeVisible();
    }
    await this.settings();
    return "E2E Staging Test";
  }
  /** @returns {Promise<Metrics>} */
  async metrics(includeTest = true) {
    await this.overview(includeTest);
    if (includeTest)
      await expect(
        this.frame.locator('s-banner[heading="Test orders included"]'),
      ).toBeVisible();
    const tile = (label = "") =>
      this.frame
        .locator("s-box")
        .filter({ has: this.frame.getByText(label, { exact: true }) });
    const value = async (label = "") =>
      Number(
        (await tile(label).locator("s-heading").innerText()).replace(
          /[^\d.-]/g,
          "",
        ),
      );
    const caption = await tile("Attach rate").innerText();
    const eligibleOrders = Number(
      caption.match(/([\d,]+) eligible orders?/)?.[1].replaceAll(",", ""),
    );
    const result = {
      revenue: await value("Protection revenue"),
      protectedOrders: await value("Protected orders"),
      netRevenue: await value("Net protection revenue"),
      eligibleOrders,
    };
    for (const amount of Object.values(result))
      expect(Number.isFinite(amount)).toBe(true);
    return result;
  }
  /** @param {Metrics} expected */
  async expectMetrics(expected) {
    await expect
      .poll(() => this.metrics(true), {
        timeout: INGESTION_TIMEOUT,
        intervals: [2000, 5000, 10000],
        message:
          "Overview did not reach the expected paid-order/refund totals.",
      })
      .toEqual(expected);
  }
  async findOrder(email = "") {
    if (!/^e2e-[a-z0-9-]+@example\.com$/.test(email))
      throw new Error("Order lookup must use a synthetic test email.");
    await this.page.goto(
      `${this.storeAdmin}/orders?query=${encodeURIComponent(`email:${email}`)}`,
    );
    const link = this.page
      .locator('a[href*="/orders/"]')
      .filter({ hasText: /^#\d+/ });
    await expect(link).toHaveCount(1, { timeout: 60_000 });
    const href = await link.getAttribute("href");
    const id = href?.match(/\/orders\/(\d+)/)?.[1];
    if (!id)
      throw new Error("Shopify Admin did not expose a unique test order ID.");
    return `gid://shopify/Order/${id}`;
  }
  async refundProtection(gid = "", amount = 1, currency = "USD") {
    const id = gid.match(/^gid:\/\/shopify\/Order\/(\d+)$/)?.[1];
    if (!id) throw new Error("Invalid Shopify order ID.");
    await this.page.goto(`${this.storeAdmin}/orders/${id}`);
    await expect(
      this.page.getByText(/Test order|Test payment/i).first(),
    ).toBeVisible();
    await this.page
      .getByRole("button", { name: "Refund", exact: true })
      .click();
    const rows = this.page.getByRole("row");
    for (const quantity of await rows.getByRole("spinbutton").all()) {
      if (await quantity.isEditable()) await quantity.fill("0");
    }
    const protection = rows.filter({ hasText: /Shipping protection/i });
    await expect(protection).toHaveCount(1);
    await protection.getByRole("spinbutton").fill("1");
    for (const quantity of await rows.getByRole("spinbutton").all()) {
      if (await quantity.isEditable()) {
        const isProtection = await protection
          .getByRole("spinbutton")
          .evaluate(
            (element, other) => element === other,
            await quantity.elementHandle(),
          );
        await expect(quantity).toHaveValue(isProtection ? "1" : "0");
      }
    }
    for (const checkbox of await this.page
      .getByRole("checkbox", {
        name: /^Shipping(?:\s|$)|Duties and import taxes|Additional fees|Customs clearance/i,
      })
      .all()) {
      if (await checkbox.isVisible()) await checkbox.setChecked(false);
    }
    const additional = this.page
      .getByRole("textbox", { name: /Shipping refund|Additional refund|Custom refund/i })
      .or(this.page.getByRole("spinbutton", { name: /Shipping refund|Additional refund|Custom refund/i }));
    for (const field of await additional.all()) {
      if (await field.isVisible()) {
        await field.fill("0");
        expect(Number(await field.inputValue())).toBe(0);
      }
    }
    const refund = this.page.getByRole("button", { name: /^Refund\s.+/ });
    await expect(refund).toHaveCount(1);
    assertRefundTotal(
      (await refund.getAttribute("aria-label")) ?? (await refund.innerText()),
      amount,
      currency,
    );
    await refund.click();
    const confirm = this.page
      .getByRole("dialog")
      .getByRole("button", { name: /^Refund/ });
    if (await confirm.isVisible()) {
      assertRefundTotal(
        (await confirm.getAttribute("aria-label")) ?? (await confirm.innerText()),
        amount,
        currency,
      );
      await confirm.click();
    }
    await expect(
      this.page.getByText(/Refunded|Partially refunded/i).first(),
    ).toBeVisible();
  }
}
