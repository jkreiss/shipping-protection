import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { orderId, PROTECTION_PRODUCT_ID, PROTECTION_VARIANT_ID, PROTECTION_RULE_ID, shopDomain } from "./dataset.js";

export class SmokeError extends Error {}
const requireCheck = (condition, message) => { if (!condition) throw new SmokeError(message); };
const IDS = [1, 2, 10];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function smokeConfig(env = process.env) {
  requireCheck(env.APP_ENV === "load", "Set APP_ENV=load.");
  requireCheck(env.LOAD_SMOKE_CONFIRM === "load-only", "Set LOAD_SMOKE_CONFIRM=load-only after checking the isolated database and load web URL.");
  requireCheck(Boolean(env.LOAD_SUPABASE_PROJECT_REF), "Set LOAD_SUPABASE_PROJECT_REF to the isolated load project's reference.");
  let database, web;
  try { database = new URL(env.DATABASE_URL); web = new URL(env.SHOPIFY_APP_URL); }
  catch { throw new SmokeError("Set valid DATABASE_URL and SHOPIFY_APP_URL values."); }
  requireCheck(["postgres:", "postgresql:"].includes(database.protocol) &&
    database.username === `postgres.${env.LOAD_SUPABASE_PROJECT_REF}`, "Database URL does not match the declared load Supabase project (use its session pooler URL).");
  requireCheck(web.protocol === "https:" && web.pathname === "/" && !web.username && !web.password && !web.search && !web.hash,
    "SHOPIFY_APP_URL must be the load web HTTPS origin.");
  requireCheck(Boolean(env.SHOPIFY_API_SECRET), "Set SHOPIFY_API_SECRET to Railway's dummy load webhook secret.");
  return { origin: web.origin, secret: env.SHOPIFY_API_SECRET, shop: shopDomain(1),
    scope: env.SCOPES ?? "write_products,read_orders,write_publications,write_cart_transforms" };
}

export function signedDelivery(config, topic, id, webhookId) {
  const payload = topic === "refunds/create" ? { id, order_id: id } : { id, admin_graphql_api_id: orderId(id) };
  const body = JSON.stringify(payload);
  return { url: `${config.origin}/webhooks/${topic}`, options: {
    method: "POST", body, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": config.shop,
      "X-Shopify-Webhook-Id": webhookId, "X-Shopify-Event-Id": webhookId,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", config.secret).update(body).digest("base64"),
    },
  } };
}

export function assertSmokeSnapshot({ orders, refunds }) {
  requireCheck(orders.length === 3 && new Set(orders.map(({ shopifyOrderId }) => shopifyOrderId)).size === 3,
    "Expected exactly three smoke orders.");
  for (const order of orders) {
    const id = Number(order.shopifyOrderId.split("/").at(-1));
    requireCheck(IDS.includes(id) && order.firstPaidAt && order.currencyCode === "AUD" &&
      order.name === `#LOAD-load-1.myshopify.com-${id}` && Number(order.totalAmount) === (id === 1 ? 100 : 102),
      "Stored order differs from the mock dataset.");
    if (id === 1) requireCheck(!order.protectionPurchase && !order.paidProtected, "Unexpected protection purchase on unprotected order.");
    else requireCheck(order.paidProtected && order.protectionPurchase?.purchasedAt &&
      Number(order.protectionPurchase.feeAmount) === 2 && order.protectionPurchase.currencyCode === "AUD" && order.protectionPurchase.attributionStatus === "ATTRIBUTED" &&
      order.protectionPurchase.pricingCheck === "MATCHED", "Expected an attributed, correctly priced AUD 2 purchase.");
  }
  const refundedOrder = orders.find(({ shopifyOrderId }) => shopifyOrderId === orderId(10));
  requireCheck(refunds.length === 1 && refunds[0].shopifyRefundId === "gid://shopify/Refund/10" &&
    refunds[0].currencyCode === "AUD" && refunds[0].orderId === refundedOrder.id &&
    refunds[0].status === "CONFIRMED" && Number(refunds[0].amount) === 2,
    "Expected exactly one confirmed AUD 2 protection refund.");
}

export function assertSmokeShopReady(shop, now) {
  requireCheck(shop.installationState === "INSTALLED", "Existing fake shop is not installed.");
  requireCheck(shop.orderReconciliationSince && !shop.orderReconciliationCursor && !shop.orderReconciliationUntil &&
    now.getTime() - shop.orderReconciliationSince.getTime() < 10 * 60_000,
    "Existing fake shop has a backfill or reconciliation window pending; finish that campaign before running a quick smoke test.");
}

export async function seedLoadShop(database, config, { fresh = false, watermark = new Date() } = {}) {
  // A fresh isolated database may contain earlier load fixtures, but no real shops.
  const realShop = await database.shop.findFirst({ where: { NOT: { shopDomain: { startsWith: "load-" } } }, select: { id: true } });
  requireCheck(!realShop, "Database contains non-load shops; refusing to seed.");
  return database.$transaction(async (tx) => {
    requireCheck(!fresh || !await tx.shop.findUnique({ where: { shopDomain: config.shop } }),
      "Campaign requires fresh shops. Choose an unused LOAD_SHOP_START; existing data is preserved.");
    const now = new Date();
    const shop = await tx.shop.upsert({ where: { shopDomain: config.shop },
      // Avoid triggering a potentially large initial backfill during this quick test.
      create: { shopDomain: config.shop, orderReconciliationSince: watermark }, update: {} });
    assertSmokeShopReady(shop, now);
    const effectiveAt = new Date("2000-01-01T00:00:00Z");
    const rule = await tx.pricingRule.upsert({ where: { shopId_ruleId: { shopId: shop.id, ruleId: PROTECTION_RULE_ID } },
      create: { shopId: shop.id, ruleId: PROTECTION_RULE_ID, version: 1, productId: PROTECTION_PRODUCT_ID,
        variantId: PROTECTION_VARIANT_ID, rateBasisPoints: 200, basis: "SHIPPABLE_PRE_DISCOUNT", state: "ACTIVE",
        effectiveAt, publishedAt: effectiveAt, activatedAt: effectiveAt }, update: {} });
    requireCheck(rule.version === 1 && rule.rateBasisPoints === 200 && rule.variantId === PROTECTION_VARIANT_ID &&
      rule.basis === "SHIPPABLE_PRE_DISCOUNT" && rule.state === "ACTIVE", "Existing load pricing rule differs from the smoke fixture.");
    await tx.shop.update({ where: { id: shop.id }, data: { activePricingRuleId: rule.id, activePricingRuleShopId: shop.id } });
    const session = { shop: config.shop, state: "load", isOnline: false, scope: config.scope,
      accessToken: "load-dummy-token", expires: null, refreshToken: null, refreshTokenExpires: null };
    await tx.session.upsert({ where: { id: `offline_${config.shop}` },
      create: { id: `offline_${config.shop}`, ...session }, update: session });
    return shop;
  });
}

export async function runSmoke(database, config) {
  const health = await fetch(`${config.origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  requireCheck(health.ok, `Load web health check returned HTTP ${health.status}.`);
  const shop = await seedLoadShop(database, config);
  process.stdout.write("Seeded load-1.myshopify.com and its dummy offline session/pricing rule.\n");
  const run = `smoke-${randomUUID()}`;
  const events = [["orders/paid", 1], ["orders/updated", 2], ["refunds/create", 10],
    ["orders/paid", 2], ["orders/paid", 10], ["orders/create", 2]].map(([topic, id], index) => ({ topic, id, webhookId: `${run}-${index}` }));
  for (const event of [...events, events[3], events[2]]) {
    const request = signedDelivery(config, event.topic, event.id, event.webhookId);
    const response = await fetch(request.url, request.options);
    requireCheck(response.ok, `Webhook ${event.topic} returned HTTP ${response.status}; check the load web URL, dummy secret, and web logs.`);
  }
  process.stdout.write("Sent 8 deliveries (6 unique); waiting up to 180 seconds for the deployed worker.\n");
  const where = { shopId: shop.id, webhookId: { in: events.map(({ webhookId }) => webhookId) } };
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const deliveries = await database.webhookDelivery.findMany({ where, select: { status: true, errorMessage: true } });
    requireCheck(!deliveries.some(({ status }) => status === "FAILED"), "Worker reported a terminal delivery failure; check worker logs.");
    if (deliveries.length === 6 && deliveries.every(({ status }) => status === "PROCESSED")) {
      const orders = await database.order.findMany({ where: { shopId: shop.id, shopifyOrderId: { in: IDS.map(orderId) } }, include: { protectionPurchase: true } });
      const refunds = await database.protectionRefund.findMany({ where: { shopId: shop.id, orderId: { in: orders.map(({ id }) => id) } } });
      assertSmokeSnapshot({ orders, refunds });
      process.stdout.write("PASS: 3 paid orders, 2 purchases totaling AUD 4, 1 refund totaling AUD 2; 6 unique deliveries processed.\n");
      return;
    }
    await pause(2000);
  }
  throw new SmokeError("Timed out waiting for processing. Check worker logs, private mock URL/token, mock order count (at least 10), and database settings.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let database;
  try {
    const config = smokeConfig();
    const { PrismaClient } = await import("@prisma/client");
    database = new PrismaClient();
    await runSmoke(database, config);
  } catch (error) {
    // Database exceptions can include connection details; print only our safe messages.
    process.stderr.write(`FAIL: ${error instanceof SmokeError ? error.message : "Database or network operation failed; check load configuration and service logs."}\n`);
    process.exitCode = 1;
  } finally {
    if (database) await database.$disconnect();
  }
}
