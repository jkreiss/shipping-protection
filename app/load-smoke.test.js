import { expect, test } from "vitest";
import { smokeConfig, assertSmokeSnapshot, assertSmokeShopReady, signedDelivery } from "../scripts/load/smoke.js";
import { createHmac } from "node:crypto";

const env = { APP_ENV: "load", LOAD_SMOKE_CONFIRM: "load-only", LOAD_SUPABASE_PROJECT_REF: "fake-ref",
  DATABASE_URL: "postgresql://postgres.fake-ref:dummy@pooler.example:5432/postgres",
  SHOPIFY_APP_URL: "https://load-web.example", SHOPIFY_API_SECRET: "load-dummy-secret" };

test("refuses a missing isolation confirmation, mismatched database, or missing secret", () => {
  expect(() => smokeConfig({ ...env, APP_ENV: "production" })).toThrow(/APP_ENV/);
  expect(() => smokeConfig({ ...env, LOAD_SMOKE_CONFIRM: "" })).toThrow(/CONFIRM/);
  expect(() => smokeConfig({ ...env, LOAD_SUPABASE_PROJECT_REF: "other-ref" })).toThrow(/project/);
  expect(() => smokeConfig({ ...env, SHOPIFY_API_SECRET: "" })).toThrow(/secret/);
});

test("signs exactly the sent bytes and preserves an ID for duplicate delivery", () => {
  const config = smokeConfig(env);
  const request = signedDelivery(config, "orders/paid", 2, "same-id");
  expect(request.url).toBe("https://load-web.example/webhooks/orders/paid");
  expect(JSON.parse(request.options.body).id).toBe(2);
  expect(request.options.headers["X-Shopify-Shop-Domain"]).toBe("load-1.myshopify.com");
  expect(request.options.headers["X-Shopify-Webhook-Id"]).toBe("same-id");
  expect(request.options.headers["X-Shopify-Hmac-Sha256"]).toBe(
    createHmac("sha256", "load-dummy-secret").update(request.options.body).digest("base64"),
  );
});

test("refuses an existing backfill, partial window or stale reconciliation watermark", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const ready = { installationState: "INSTALLED", orderReconciliationSince: now, orderReconciliationCursor: null, orderReconciliationUntil: null };
  expect(() => assertSmokeShopReady(ready, now)).not.toThrow();
  for (const override of [{ orderReconciliationSince: null }, { orderReconciliationCursor: "active" },
    { orderReconciliationSince: new Date("2026-09-01T00:00:00Z") }]) {
    expect(() => assertSmokeShopReady({ ...ready, ...override }, now)).toThrow(/backfill/);
  }
});

function snapshot() {
  return {
    orders: [1, 2, 10].map((id) => ({ id: `local-${id}`, shopifyOrderId: `gid://shopify/Order/${id}`, firstPaidAt: new Date(),
      currencyCode: "AUD", name: `#LOAD-load-1.myshopify.com-${id}`, totalAmount: id === 1 ? "100" : "102",
      paidProtected: id !== 1, protectionPurchase: id === 1 ? null : {
        feeAmount: "2", currencyCode: "AUD", attributionStatus: "ATTRIBUTED", pricingCheck: "MATCHED", purchasedAt: new Date() } })),
    refunds: [{ shopifyRefundId: "gid://shopify/Refund/10", orderId: "local-10", currencyCode: "AUD", amount: "2", status: "CONFIRMED" }],
  };
}

test("detects missing, doubled or incorrect financial results", () => {
  expect(() => assertSmokeSnapshot(snapshot())).not.toThrow();
  const wrongFee = snapshot(); wrongFee.orders[1].protectionPurchase.feeAmount = "4";
  expect(() => assertSmokeSnapshot(wrongFee)).toThrow(/purchase/);
  const missing = snapshot(); missing.orders.pop();
  expect(() => assertSmokeSnapshot(missing)).toThrow(/orders/);
  const doubled = snapshot(); doubled.refunds.push(doubled.refunds[0]);
  expect(() => assertSmokeSnapshot(doubled)).toThrow(/refund/);
  const wrongOrder = snapshot(); wrongOrder.refunds[0].orderId = "local-2";
  expect(() => assertSmokeSnapshot(wrongOrder)).toThrow(/refund/);
  const wrongCurrency = snapshot(); wrongCurrency.refunds[0].currencyCode = "USD";
  expect(() => assertSmokeSnapshot(wrongCurrency)).toThrow(/refund/);
});
