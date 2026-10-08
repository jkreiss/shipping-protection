import { expect, test, vi } from "vitest";
import { campaignConfig, campaignEvents, checkCampaignOrder, sendCampaignEvents, verifyCampaign, runCampaign } from "../scripts/load/campaign.js";

const env = { APP_ENV: "load", LOAD_SMOKE_CONFIRM: "load-only", LOAD_SUPABASE_PROJECT_REF: "fake",
  DATABASE_URL: "postgresql://postgres.fake:dummy@pooler.example/postgres", SHOPIFY_APP_URL: "https://load.example",
  SHOPIFY_API_SECRET: "dummy", LOAD_ORDERS_PER_SHOP: "20", LOAD_SHOP_START: "2", LOAD_SHOPS: "2" };

test("campaign configuration bounds traffic and refuses smoke tenant reuse", () => {
  expect(campaignConfig("burst", env).orders).toBe(20);
  for (const change of [{ LOAD_SHOP_START: "1" }, { LOAD_SHOPS: "0" }, { LOAD_CONCURRENCY: "999" },
    { LOAD_ORDERS_PER_SHOP: "2.5" }, { LOAD_TIMEOUT_SECONDS: "NaN" }]) {
    expect(() => campaignConfig("burst", { ...env, ...change })).toThrow();
  }
  expect(() => campaignConfig("other", env)).toThrow();
});

test("lazy events cover each tenant with reordered topics and stable duplicate IDs", () => {
  const config = campaignConfig("burst", env);
  const events = [...campaignEvents(config, "run")];
  expect(events).toHaveLength(88); // 2 shops * (20 paid + 20 updated + 2 refund + 2 duplicate)
  for (const shop of ["load-2.myshopify.com", "load-3.myshopify.com"]) {
    const own = events.filter((event) => event.shop === shop);
    expect(new Set(own.map((event) => event.webhookId)).size).toBe(42);
    expect(own.findIndex((event) => event.topic === "refunds/create" && event.id === 10))
      .toBeLessThan(own.findIndex((event) => event.topic === "orders/paid" && event.id === 10));
  }
});

test("reconciliation requires the full declared dataset to fit the discovery window", () => {
  const dates = { LOAD_MOCK_START_AT: new Date(Date.now() - 86_400_000).toISOString(), LOAD_MOCK_INTERVAL_MS: "1000" };
  expect(() => campaignConfig("reconcile", { ...env, ...dates })).not.toThrow();
  for (const start of ["bad", new Date(Date.now() + 86_400_000).toISOString(), new Date(Date.now() - 61 * 86_400_000).toISOString()]) {
    expect(() => campaignConfig("reconcile", { ...env, ...dates, LOAD_MOCK_START_AT: start })).toThrow(/past/);
  }
});

function order(id = 10) {
  return { id: "local", shopifyOrderId: `gid://shopify/Order/${id}`, name: `#LOAD-load-2.myshopify.com-${id}`,
    firstPaidAt: new Date(), paidEligible: true, paidProtected: id % 2 === 0, paidProtectionFee: id % 2 === 0 ? "2" : "0",
    currencyCode: "AUD", totalAmount: id % 2 === 0 ? "102" : "100",
    protectionPurchase: id % 2 ? null : { purchasedAt: new Date(), feeAmount: "2", currencyCode: "AUD", attributionStatus: "ATTRIBUTED", pricingCheck: "MATCHED" },
    protectionRefunds: id % 10 ? [] : [{ shopifyRefundId: `gid://shopify/Refund/${id}`, orderId: "local", status: "CONFIRMED", amount: "2", currencyCode: "AUD" }] };
}

test("financial verification rejects wrong tenant, fee, refund linkage, missing and extra refunds", () => {
  expect(() => checkCampaignOrder(order(), "load-2.myshopify.com", 20)).not.toThrow();
  expect(() => checkCampaignOrder(order(1), "load-2.myshopify.com", 20)).not.toThrow();
  for (const change of [{ name: "#LOAD-load-3.myshopify.com-10" }, { paidProtectionFee: "4" },
    { protectionPurchase: null }, { protectionRefunds: [] }, { protectionRefunds: [order().protectionRefunds[0], order().protectionRefunds[0]] },
    { protectionRefunds: [{ ...order().protectionRefunds[0], orderId: "other" }] }]) {
    expect(() => checkCampaignOrder({ ...order(), ...change }, "load-2.myshopify.com", 20)).toThrow();
  }
  expect(() => checkCampaignOrder(order(21), "load-2.myshopify.com", 20)).toThrow();
});

test("bounded sender retries transient errors using the same event ID and fails on rejection", async () => {
  const config = { ...campaignConfig("burst", env), concurrency: 2 };
  let active = 0, peak = 0;
  const attempts = new Map();
  const fakeFetch = async (_url, options) => {
    const id = options.headers["X-Shopify-Webhook-Id"];
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    return { ok: attempts.get(id) > 1, status: attempts.get(id) > 1 ? 200 : 503, body: { cancel: async () => {} } };
  };
  const events = [...campaignEvents(config, "retry")].slice(0, 4);
  const result = await sendCampaignEvents(config, events.values(), fakeFetch, async () => {});
  expect(peak).toBeLessThanOrEqual(2);
  expect(result.accepted).toBe(4);
  expect(result.retries).toBe(4);
  expect([...attempts.values()]).toEqual([2, 2, 2, 2]);
  await expect(sendCampaignEvents(config, events.values(), async () => ({ ok: false, status: 401, body: null }), async () => {}))
    .rejects.toThrow(/401/);
});

test("complete-set verification catches a missing unprotected order even when financial counts match", async () => {
  const config = { ...campaignConfig("burst", env), shops: 1 };
  const shops = [{ id: "shop", shopDomain: "load-2.myshopify.com" }];
  let rows = Array.from({ length: 20 }, (_, index) => order(index + 1));
  const database = { order: { findMany: async () => rows },
    protectionPurchase: { count: async () => 10 }, protectionRefund: { count: async () => 2 } };
  expect(await verifyCampaign(database, shops, config)).toEqual({ orders: 20, purchases: 10, purchaseAud: 20, refunds: 2, refundAud: 4 });
  rows = rows.slice(1);
  await expect(verifyCampaign(database, shops, config)).rejects.toThrow(/found 19/);
});

test("sender stops after bounded network retries and enforces submission deadline", async () => {
  const config = { ...campaignConfig("burst", env), concurrency: 1 };
  let attempts = 0;
  await expect(sendCampaignEvents(config, campaignEvents(config, "network"), async () => {
    attempts++; throw new Error("network down");
  }, async () => {})).rejects.toThrow(/four attempts/);
  expect(attempts).toBe(4);
  await expect(sendCampaignEvents(config, campaignEvents(config, "timeout"), async () => {
    throw new Error("should never send");
  }, async () => {}, Date.now() - 1)).rejects.toThrow(/timeout/);
});

test("two discovery passes require changed worker watermarks despite laptop clock skew", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08"));
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    body: { cancel: async () => {} },
  }));
  let pass = 0,
    polls = 0;
  const financialChecks = [];
  const workerTimes = [new Date("2000-01-01"), new Date("2000-01-02")];
  let shop;
  const poll = () => {
    polls++;
    // An active window never counts as done. On pass two, a repeated previous
    // watermark must not count, even with its cursor and window cleared.
    const since =
      pass === 2 && polls === 1 ? workerTimes[0] : workerTimes[pass - 1];
    return [
      {
        ...shop,
        orderReconciliationSince: since,
        orderReconciliationCursor: pass === 1 && polls === 1 ? "active" : null,
        orderReconciliationUntil:
          pass === 1 && polls === 1 ? workerTimes[0] : null,
      },
    ];
  };
  const db = {
    shop: {
      findFirst: async () => null,
      findUnique: async () => shop,
      upsert: async ({ create }) =>
        (shop = { id: "shop", installationState: "INSTALLED", ...create }),
      update: async () => shop,
      updateMany: async () => {
        pass++;
        polls = 0;
        return { count: 1 };
      },
      findMany: async () => poll(),
      count: async ({ where }) =>
        poll().filter(
          (row) =>
            !row.orderReconciliationCursor &&
            row.orderReconciliationSince >= where.orderReconciliationSince.gte,
        ).length,
    },
    pricingRule: { upsert: async ({ create }) => create },
    session: { upsert: async () => {} },
    webhookDelivery: { groupBy: async () => [] },
    order: {
      findMany: async () => {
        financialChecks.push({ pass, polls });
        return Array.from({ length: 20 }, (_, n) => order(n + 1));
      },
    },
    protectionPurchase: { count: async () => 10 },
    protectionRefund: { count: async () => 2 },
    $transaction: async (run) => run(db),
  };
  const report = { run: "two-passes" };
  let failure;
  try {
    const pending = runCampaign(
      db,
      {
        ...campaignConfig("burst", env),
        mode: "reconcile",
        shops: 1,
        timeoutSeconds: 30,
      },
      report,
    ).catch((error) => {
      failure = error;
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(failure).toBeUndefined();
    expect(financialChecks).toEqual([
      { pass: 1, polls: 2 },
      { pass: 2, polls: 2 },
      { pass: 2, polls: 2 },
    ]);
    expect(report.passes.map((entry) => entry.totals)).toEqual([
      { orders: 20, purchases: 10, purchaseAud: 20, refunds: 2, refundAud: 4 },
      { orders: 20, purchases: 10, purchaseAud: 20, refunds: 2, refundAud: 4 },
    ]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
