import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  applySubscriptionWebhook,
  parseBillingTerms,
  requestBillingApproval,
  requestCapApproval,
  setBillingTerms,
  subscriptionName,
  subscriptionTransition,
  syncBillingAgreement,
} from "./agreements.server.js";
import { UserFacingError } from "../user-facing-error.js";

const billingAdmin = vi.hoisted(() => ({
  readBillingPreferences: vi.fn(),
  createUsageSubscription: vi.fn(),
  updateUsageCap: vi.fn(),
  cancelSubscription: vi.fn(),
  readActiveSubscriptions: vi.fn(),
  readSubscription: vi.fn(),
}));
vi.mock("../shopify/billing-admin.server.js", () => billingAdmin);
vi.mock("../observability.server.js", () => ({ logEvent: vi.fn(), reportCondition: vi.fn(), reportFailure: vi.fn() }));

const now = new Date("2026-10-07T10:00:00Z");
const decimal = (text) => ({ toFixed: (digits) => Number(text).toFixed(digits) });

// An in-memory stand-in for the Prisma calls agreements make.
function fakeDatabase({ agreements = [], installed = true, shops } = {}) {
  const state = {
    shops: shops ?? [{ id: "shop-1", shopDomain: "one.myshopify.com", shopGid: "gid://shopify/Shop/1",
      installationState: installed ? "INSTALLED" : "UNINSTALLED", settingsLockedUntil: null }],
    agreements: agreements.map((row) => ({ ...row })),
    chargeUpdates: [],
  };
  const matches = (row, where) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
  const database = {
    state,
    shop: {
      findUnique: vi.fn(async ({ where }) => state.shops.find((shop) => shop.shopDomain === where.shopDomain) ?? null),
      updateMany: vi.fn(async ({ where, data }) => {
        const shop = state.shops.find((row) => row.shopDomain === where.shopDomain);
        if (!shop) return { count: 0 };
        Object.assign(shop, data);
        return { count: 1 };
      }),
    },
    billingAgreement: {
      findFirst: vi.fn(async ({ where, orderBy }) => {
        const rows = state.agreements.filter((row) => matches(row, where));
        if (orderBy?.version === "desc") rows.sort((a, b) => b.version - a.version);
        return rows[0] ?? null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = state.agreements.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: `agreement-${state.agreements.length + 1}`, pendingCappedAmount: null,
          subscriptionGid: null, usageLineItemGid: null, endedAt: null, ...data };
        state.agreements.push(row);
        return row;
      }),
    },
    billingCharge: {
      updateMany: vi.fn(async (args) => { state.chargeUpdates.push(args); return { count: 1 }; }),
    },
    $transaction: vi.fn(async (run) => run(database)),
  };
  return database;
}

const admin = { name: "admin" };
const adminForShop = vi.fn(async () => ({ admin }));
const audPreferences = { shopCurrency: "AUD", billingCurrency: "AUD", developmentStore: false };
const activeNet = {
  id: "agreement-1", shopId: "shop-1", version: 1, mode: "NET_SHARE", rateBasisPoints: 1_000,
  cappedAmount: decimal("100"), pendingCappedAmount: null, currencyCode: "AUD", status: "ACTIVE",
  subscriptionGid: "gid://shopify/AppSubscription/1", usageLineItemGid: "li-1", activatedAt: new Date("2026-10-01T00:00:00Z"),
};
const pendingNet = { ...activeNet, status: "PENDING_APPROVAL", subscriptionGid: null, usageLineItemGid: null, activatedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  billingAdmin.readBillingPreferences.mockResolvedValue(audPreferences);
  billingAdmin.readActiveSubscriptions.mockResolvedValue([]);
});

describe("parsing the operator's terms", () => {
  test.each([
    [["free"], { mode: "FREE", rateBasisPoints: 0, cappedAmount: null }],
    [["gross", "10", "100"], { mode: "GROSS_SHARE", rateBasisPoints: 1_000, cappedAmount: "100.0000" }],
    [["net", "2.5", "50.25"], { mode: "NET_SHARE", rateBasisPoints: 250, cappedAmount: "50.2500" }],
  ])("%j", (args, terms) => {
    expect(parseBillingTerms(args)).toEqual(terms);
  });

  test.each([
    [["net"]], [["net", "10"]], [["net", "0", "100"]], [["net", "101", "100"]], [["net", "10", "0"]],
    [["net", "10", "-5"]], [["net", "10", "1.234"]], [["free", "10"]], [["half", "10", "100"]],
    [["net", "10", "100", "extra"]],
  ])("rejects %j", (args) => {
    expect(() => parseBillingTerms(args)).toThrow(UserFacingError);
  });
});

describe("the operator setting terms", () => {
  test("rejects a store that is not installed", async () => {
    const database = fakeDatabase({ installed: false });
    await expect(setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["net", "10", "100"]), database, adminForShop, now }))
      .rejects.toThrow("Choose an installed store");
    await expect(setBillingTerms({ shopDomain: "not a domain", terms: parseBillingTerms(["free"]), database, adminForShop, now }))
      .rejects.toThrow(UserFacingError);
  });

  test("records new terms awaiting the merchant's approval, in the billing currency", async () => {
    const database = fakeDatabase();
    const result = await setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["net", "10", "100"]), database, adminForShop, now });

    expect(result.outcome).toBe("requested");
    expect(result.agreement).toMatchObject({
      shopId: "shop-1", version: 1, mode: "NET_SHARE", rateBasisPoints: 1_000, cappedAmount: "100.0000",
      currencyCode: "AUD", status: "PENDING_APPROVAL", activatedAt: null,
    });
    expect(database.state.shops[0].settingsLockedUntil).toBeNull();
    expect(database.shop.updateMany).toHaveBeenCalledTimes(2);
  });

  test("refuses terms when the store sells and is billed in different currencies", async () => {
    billingAdmin.readBillingPreferences.mockResolvedValue({ ...audPreferences, billingCurrency: "USD" });
    const database = fakeDatabase();
    await expect(setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["net", "10", "100"]), database, adminForShop, now }))
      .rejects.toThrow("sells in AUD but is billed in USD");
    expect(database.state.agreements).toEqual([]);
  });

  test("leaves identical terms alone", async () => {
    const database = fakeDatabase({ agreements: [activeNet] });
    const result = await setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["net", "10", "100"]), database, adminForShop, now });
    expect(result.outcome).toBe("unchanged");
    expect(database.billingAgreement.create).not.toHaveBeenCalled();
  });

  test("a higher cap on the same active terms waits for the merchant without a new subscription", async () => {
    const database = fakeDatabase({ agreements: [activeNet] });
    const result = await setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["net", "10", "250"]), database, adminForShop, now });

    expect(result.outcome).toBe("cap-requested");
    expect(database.state.agreements).toHaveLength(1);
    expect(database.state.agreements[0]).toMatchObject({ status: "ACTIVE", pendingCappedAmount: "250.0000" });
    expect(billingAdmin.cancelSubscription).not.toHaveBeenCalled();
  });

  test("switching to free settles what is owed, cancels the subscription and supersedes the terms", async () => {
    const database = fakeDatabase({ agreements: [activeNet] });
    const settle = vi.fn(async () => ({ billed: 1, unbilled: 0 }));
    billingAdmin.cancelSubscription.mockResolvedValue("CANCELLED");

    const result = await setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["free"]), database, adminForShop, now, settle });

    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ agreement: expect.objectContaining({ id: "agreement-1" }) }));
    expect(billingAdmin.cancelSubscription).toHaveBeenCalledWith(admin, "one.myshopify.com", "gid://shopify/AppSubscription/1");
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(billingAdmin.cancelSubscription.mock.invocationCallOrder[0]);
    expect(database.state.agreements[0]).toMatchObject({ status: "SUPERSEDED", endedAt: now });
    expect(result).toMatchObject({ outcome: "free", settlement: { billed: 1, unbilled: 0 } });
    expect(result.agreement).toMatchObject({ version: 2, mode: "FREE", rateBasisPoints: 0, status: "ACTIVE", activatedAt: now, cappedAmount: null });
  });

  test("new terms replace terms the merchant has not approved yet, without touching Shopify", async () => {
    const database = fakeDatabase({ agreements: [pendingNet] });
    const result = await setBillingTerms({ shopDomain: "one.myshopify.com", terms: parseBillingTerms(["gross", "5", "100"]), database, adminForShop, now, settle: vi.fn() });

    expect(billingAdmin.cancelSubscription).not.toHaveBeenCalled();
    expect(database.state.agreements[0].status).toBe("SUPERSEDED");
    expect(result.agreement).toMatchObject({ version: 2, mode: "GROSS_SHARE", status: "PENDING_APPROVAL" });
  });
});

describe("the merchant approving billing", () => {
  test("creates the capped usage subscription and returns Shopify's approval page", async () => {
    billingAdmin.readBillingPreferences.mockResolvedValue({ ...audPreferences, developmentStore: true });
    billingAdmin.createUsageSubscription.mockResolvedValue({
      subscriptionGid: "gid://shopify/AppSubscription/7", usageLineItemGid: "li-7", confirmationUrl: "https://confirm",
    });
    const database = fakeDatabase({ agreements: [pendingNet] });

    const url = await requestBillingApproval({ admin, shopDomain: "one.myshopify.com", returnUrl: "https://return", database });

    expect(url).toBe("https://confirm");
    expect(billingAdmin.createUsageSubscription).toHaveBeenCalledWith(admin, "one.myshopify.com", {
      name: subscriptionName(1), terms: "10% of protection revenue, net of protection refunds",
      cappedAmount: "100.0000", currencyCode: "AUD", returnUrl: "https://return", test: true,
    });
    expect(database.state.agreements[0]).toMatchObject({
      status: "PENDING_APPROVAL", subscriptionGid: "gid://shopify/AppSubscription/7", usageLineItemGid: "li-7",
    });
  });

  test("explains when there is nothing to approve", async () => {
    const database = fakeDatabase({ agreements: [activeNet] });
    await expect(requestBillingApproval({ admin, shopDomain: "one.myshopify.com", returnUrl: "x", database }))
      .rejects.toThrow(UserFacingError);
    expect(billingAdmin.createUsageSubscription).not.toHaveBeenCalled();
  });

  test("asks Shopify to approve a raised cap", async () => {
    billingAdmin.updateUsageCap.mockResolvedValue("https://confirm-cap");
    const database = fakeDatabase({ agreements: [{ ...activeNet, pendingCappedAmount: decimal("250") }] });
    await expect(requestCapApproval({ admin, shopDomain: "one.myshopify.com", database })).resolves.toBe("https://confirm-cap");
    expect(billingAdmin.updateUsageCap).toHaveBeenCalledWith(admin, "one.myshopify.com", {
      lineItemId: "li-1", cappedAmount: "250.0000", currencyCode: "AUD",
    });
  });
});

describe("subscription status changes", () => {
  test.each([
    ["approval activates pending terms", pendingNet, { status: "ACTIVE" }, { status: "ACTIVE", activatedAt: now }],
    ["declining ends pending terms", pendingNet, { status: "DECLINED" }, { status: "DECLINED", endedAt: now }],
    ["an expired approval page leaves terms pending", pendingNet, { status: "EXPIRED" }, null],
    ["cancelling ends active terms", activeNet, { status: "CANCELLED" }, { status: "CANCELLED", endedAt: now }],
    ["a frozen store keeps its terms", activeNet, { status: "FROZEN" }, null],
    ["an approved higher cap replaces the cap", { ...activeNet, pendingCappedAmount: decimal("250") },
      { status: "ACTIVE", cappedAmount: "250.0" }, { cappedAmount: "250.0000", pendingCappedAmount: null }],
    ["a cap below the requested one is not approval", { ...activeNet, pendingCappedAmount: decimal("250") },
      { status: "ACTIVE", cappedAmount: "100.0" }, null],
  ])("%s", (_name, agreement, change, patch) => {
    expect(subscriptionTransition(agreement, change, now)).toEqual(patch);
  });

  const webhook = (fields) => ({ app_subscription: {
    admin_graphql_api_id: "gid://shopify/AppSubscription/7", admin_graphql_api_shop_id: "gid://shopify/Shop/1",
    name: subscriptionName(1), status: "ACTIVE", capped_amount: "100.0", currency: "AUD", ...fields,
  } });

  test("the webhook activates the shop's own matching agreement", async () => {
    const database = fakeDatabase({ agreements: [{ ...pendingNet, subscriptionGid: "gid://shopify/AppSubscription/7", usageLineItemGid: "li-7" }] });
    await expect(applySubscriptionWebhook({ shopDomain: "one.myshopify.com", payload: webhook(), database, now })).resolves.toBe("updated");
    expect(database.state.agreements[0]).toMatchObject({ status: "ACTIVE", activatedAt: now });
  });

  test("the webhook ignores a subscription that belongs to another shop", async () => {
    const database = fakeDatabase({
      shops: [
        { id: "shop-1", shopDomain: "one.myshopify.com", shopGid: "gid://shopify/Shop/1", installationState: "INSTALLED" },
        { id: "shop-2", shopDomain: "two.myshopify.com", shopGid: "gid://shopify/Shop/2", installationState: "INSTALLED" },
      ],
      agreements: [{ ...pendingNet, subscriptionGid: "gid://shopify/AppSubscription/7" }],
    });
    await expect(applySubscriptionWebhook({ shopDomain: "two.myshopify.com",
      payload: webhook({ admin_graphql_api_shop_id: "gid://shopify/Shop/2" }), database, now })).resolves.toBe("unmatched");
    await expect(applySubscriptionWebhook({ shopDomain: "one.myshopify.com",
      payload: webhook({ admin_graphql_api_shop_id: "gid://shopify/Shop/2" }), database, now })).resolves.toBe("ignored");
    expect(database.state.agreements[0].status).toBe("PENDING_APPROVAL");
  });

  test("an approved cap releases charges held at the old cap", async () => {
    const database = fakeDatabase({ agreements: [{ ...activeNet, subscriptionGid: "gid://shopify/AppSubscription/7", pendingCappedAmount: decimal("250") }] });
    await applySubscriptionWebhook({ shopDomain: "one.myshopify.com", payload: webhook({ capped_amount: "250.0" }), database, now });

    expect(database.state.agreements[0]).toMatchObject({ cappedAmount: "250.0000", pendingCappedAmount: null });
    expect(database.state.chargeUpdates).toEqual([{
      where: { shopId: "shop-1", agreementId: "agreement-1", status: "CAP_EXCEEDED" }, data: { nextAttemptAt: now },
    }]);
  });
});

describe("syncing with Shopify on the Settings page", () => {
  const shopifySubscription = (fields) => ({
    id: "gid://shopify/AppSubscription/8", name: subscriptionName(1), status: "ACTIVE", test: false,
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    usageLineItem: { id: "li-8", cappedAmount: "100.0", balanceUsed: "12.5", currencyCode: "AUD" }, ...fields,
  });

  test("adopts the approved subscription for pending terms by its name and reports this cycle's usage", async () => {
    billingAdmin.readActiveSubscriptions.mockResolvedValue([shopifySubscription()]);
    const database = fakeDatabase({ agreements: [{ ...pendingNet, subscriptionGid: "gid://shopify/AppSubscription/7" }] });

    const view = await syncBillingAgreement({ admin, shopDomain: "one.myshopify.com", database, now });

    expect(database.state.agreements[0]).toMatchObject({
      status: "ACTIVE", activatedAt: now, subscriptionGid: "gid://shopify/AppSubscription/8", usageLineItemGid: "li-8",
    });
    expect(view).toMatchObject({ mode: "NET_SHARE", status: "ACTIVE", billedThisCycle: "12.50", cappedAmount: "100.00",
      terms: "10% of protection revenue, net of protection refunds" });
    expect(billingAdmin.cancelSubscription).not.toHaveBeenCalled();
  });

  test("cancels a stray revenue-share subscription that no open terms own", async () => {
    billingAdmin.readActiveSubscriptions.mockResolvedValue([
      { ...shopifySubscription(), id: "gid://shopify/AppSubscription/1" },
      shopifySubscription({ id: "gid://shopify/AppSubscription/3", name: subscriptionName(0) }),
    ]);
    const database = fakeDatabase({ agreements: [activeNet] });

    await syncBillingAgreement({ admin, shopDomain: "one.myshopify.com", database, now });

    expect(billingAdmin.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(billingAdmin.cancelSubscription).toHaveBeenCalledWith(admin, "one.myshopify.com", "gid://shopify/AppSubscription/3");
  });

  test("a free shop needs no Shopify call", async () => {
    const database = fakeDatabase();
    await expect(syncBillingAgreement({ admin, shopDomain: "one.myshopify.com", database, now }))
      .resolves.toMatchObject({ mode: "FREE", terms: "No charge" });
    expect(billingAdmin.readActiveSubscriptions).not.toHaveBeenCalled();
  });
});

test("never cancels the subscription named for the open terms, even if another load adopted it first", async () => {
  billingAdmin.readActiveSubscriptions.mockResolvedValue([{
    id: "gid://shopify/AppSubscription/8", name: subscriptionName(1), status: "ACTIVE", test: false,
    currentPeriodEnd: null, usageLineItem: { id: "li-8", cappedAmount: "100.0", balanceUsed: "0.0", currencyCode: "AUD" },
  }]);
  const database = fakeDatabase({ agreements: [{ ...pendingNet, subscriptionGid: "gid://shopify/AppSubscription/7" }] });
  // A concurrent Settings load activated the agreement after this one read it.
  database.billingAgreement.updateMany.mockResolvedValueOnce({ count: 0 });

  await syncBillingAgreement({ admin, shopDomain: "one.myshopify.com", database, now });

  expect(billingAdmin.cancelSubscription).not.toHaveBeenCalled();
});
