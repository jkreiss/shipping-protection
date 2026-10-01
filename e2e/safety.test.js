// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  assertAppIdentity,
  readConfig,
  assertReadOnlyRole,
  assertFixtureCart,
  assertRefundTotal,
} from "./support/config.js";

const environment = {
  E2E_SHOP_DOMAIN: "app-test-kwvgodpl.myshopify.com",
  E2E_ADMIN_APP_URL:
    "https://admin.shopify.com/store/app-test-kwvgodpl/apps/protection-staging",
  E2E_DATABASE_URL: "postgresql://e2e_reader:example@staging.invalid/postgres",
  E2E_PHYSICAL_VARIANT_ID: "101",
  E2E_DIGITAL_VARIANT_ID: "102",
  E2E_DISCOUNT_CODE: "E2E10",
  E2E_PAYMENT_GATEWAY: "bogus",
};

describe("staging test safety", () => {
  test("accepts only the exact native protection refund total", () => {
    expect(() => assertRefundTotal("Refund $1.00", 1, "USD")).not.toThrow();
    expect(() => assertRefundTotal("Refund $1.00 USD", 1, "USD")).not.toThrow();
    expect(() => assertRefundTotal("Refund US$1.00", 1, "USD")).not.toThrow();
    for (const label of [
      "Refund $11.00",
      "Refund $101.00 USD",
      "Refund $1.50",
      "Refund $1.00 CAD",
      "Refund CA$1.00",
      "Refund",
    ])
      expect(() => assertRefundTotal(label, 1, "USD")).toThrow(/refund total/i);
  });
  test("refuses the old production-connected store", () => {
    expect(() =>
      readConfig({
        ...environment,
        E2E_SHOP_DOMAIN: "insurance-nttn9bxt.myshopify.com",
      }),
    ).toThrow(/staging store/i);
  });
  test("refuses an Admin URL belonging to a different store", () => {
    expect(() =>
      readConfig({
        ...environment,
        E2E_ADMIN_APP_URL: "https://admin.shopify.com/store/other/apps/test",
      }),
    ).toThrow(/Admin URL/i);
  });
  test("never falls back to the application database credential", () => {
    expect(() =>
      readConfig({
        ...environment,
        E2E_DATABASE_URL: "",
        DATABASE_URL: environment.E2E_DATABASE_URL,
      }),
    ).toThrow(/E2E_DATABASE_URL/);
  });
  test("requires test payment setup before running the suite", () => {
    expect(() =>
      readConfig({ ...environment, E2E_PAYMENT_GATEWAY: "live" }),
    ).toThrow(/test gateway/i);
  });
  test("allows sign-in setup without database or product credentials", () => {
    expect(
      readConfig(
        {
          E2E_SHOP_DOMAIN: environment.E2E_SHOP_DOMAIN,
          E2E_ADMIN_APP_URL: environment.E2E_ADMIN_APP_URL,
        },
        "auth",
      ).shopDomain,
    ).toBe("app-test-kwvgodpl.myshopify.com");
  });
  test("refuses a production app loaded inside the correct store", () => {
    const config = readConfig(environment);
    expect(() =>
      assertAppIdentity(config, {
        frameUrl:
          "https://insurance-backend-production-82be.up.railway.app/app/overview",
        apiKey: "96f5fc78f8240440dd885872ce8c11cb",
      }),
    ).toThrow(/staging app/i);
  });
  test("refuses a different app key at the staging origin", () => {
    const config = readConfig(environment);
    expect(() =>
      assertAppIdentity(config, {
        frameUrl: `${config.appOrigin}/app/overview`,
        apiKey: "wrong-key",
      }),
    ).toThrow(/staging app/i);
  });
  test("accepts only the configured staging app identity", () => {
    expect(() =>
      assertAppIdentity(readConfig(environment), {
        frameUrl:
          "https://insurance-backend-staging.up.railway.app/app/overview",
        apiKey: "2023a5496c2a665db70327c68082fa04",
      }),
    ).not.toThrow();
  });
  test("rejects a database login that can write application data or read sessions", () => {
    for (const capability of [
      "superuser",
      "canWrite",
      "canReadSessions",
      "canCreate",
    ]) {
      expect(() =>
        assertReadOnlyRole({
          superuser: false,
          canWrite: false,
          canReadSessions: false,
          canCreate: false,
          [capability]: true,
        }),
      ).toThrow(/read-only/i);
    }
  });
  test("rejects cart fixtures whose shipping flags or prices differ", () => {
    const config = readConfig(environment);
    const items = [
      {
        variant_id: 101,
        requires_shipping: true,
        original_price: 10000,
        quantity: 1,
      },
      {
        variant_id: 102,
        requires_shipping: false,
        original_price: 4000,
        quantity: 1,
      },
    ];
    expect(() => assertFixtureCart(items, config, true)).not.toThrow();
    expect(() =>
      assertFixtureCart(
        [{ ...items[0], requires_shipping: false }, items[1]],
        config,
        true,
      ),
    ).toThrow(/fixture/i);
    expect(() =>
      assertFixtureCart(
        [{ ...items[0], original_price: 9999 }, items[1]],
        config,
        true,
      ),
    ).toThrow(/fixture/i);
  });
});
