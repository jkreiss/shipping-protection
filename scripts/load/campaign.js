import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { smokeConfig, seedLoadShop, signedDelivery, SmokeError } from "./smoke.js";
import { shopDomain } from "./dataset.js";

class CampaignError extends Error {}
const check = (condition, message) => { if (!condition) throw new CampaignError(message); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function campaignConfig(mode, env = process.env) {
  check(["burst", "reconcile"].includes(mode), "Choose burst or reconcile.");
  const base = smokeConfig(env);
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    check(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer between ${min} and ${max}.`);
    return value;
  };
  const config = { ...base, mode,
    orders: integer("LOAD_ORDERS_PER_SHOP", 20, 1, 10_000_000),
    shops: integer("LOAD_SHOPS", 1, 1, 1000),
    shopStart: integer("LOAD_SHOP_START", mode === "burst" ? 2 : 3, 2, 10_000),
    concurrency: integer("LOAD_CONCURRENCY", 8, 1, 64),
    timeoutSeconds: integer("LOAD_TIMEOUT_SECONDS", 600, 30, 86_400),
  };
  check(config.shopStart + config.shops - 1 <= 10_000, "Selected shop range exceeds mock's maximum.");
  if (mode === "reconcile") {
    const start = Date.parse(env.LOAD_MOCK_START_AT);
    const interval = integer("LOAD_MOCK_INTERVAL_MS", 1000, 1, 86_400_000);
    check(Number.isFinite(start) && start > Date.now() - 59 * 86_400_000 &&
      start + (config.orders - 1) * interval < Date.now(),
    "Set LOAD_MOCK_START_AT and LOAD_MOCK_INTERVAL_MS to the deployed mock values; all orders must be in the past and within 59 days.");
  }
  return config;
}

export function* campaignEvents(config, run) {
  // Interleave merchants and generate lazily, including exact duplicates and reversed topics.
  for (let id = 1; id <= config.orders; id++) {
    for (let index = config.shopStart; index < config.shopStart + config.shops; index++) {
      const shop = shopDomain(index);
      if (id % 10 === 0) yield { shop, id, topic: "refunds/create", webhookId: `${run}-${index}-${id}-refund` };
      yield { shop, id, topic: "orders/updated", webhookId: `${run}-${index}-${id}-updated` };
      const paid = { shop, id, topic: "orders/paid", webhookId: `${run}-${index}-${id}-paid` };
      yield paid;
      if (id % 10 === 0) yield paid;
    }
  }
}

const httpMetrics = () => ({ accepted: 0, retries: 0, attempts: 0, latencyBuckets: Array(32).fill(0), maxLatencyMs: 0 });

export async function sendCampaignEvents(config, iterator, request = fetch, sleep = pause, deadline = Infinity, result = httpMetrics()) {
  let failure;
  await Promise.all(Array.from({ length: config.concurrency }, async () => {
    while (!failure) {
      const next = iterator.next();
      if (next.done) return;
      const event = next.value;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          check(Date.now() < deadline, "Campaign timeout during webhook submission.");
          const delivery = signedDelivery({ ...config, shop: event.shop }, event.topic, event.id, event.webhookId);
          delivery.options.signal = AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now())));
          const started = Date.now();
          let response;
          result.attempts++;
          try { response = await request(delivery.url, delivery.options); }
          catch { /* A timeout may have persisted the event; retry its exact ID. */ }
          const latency = Date.now() - started;
          result.latencyBuckets[Math.min(31, Math.ceil(Math.log2(Math.max(1, latency))))]++;
          result.maxLatencyMs = Math.max(result.maxLatencyMs, latency);
          await response?.body?.cancel();
          if (response?.ok) { result.accepted++; break; }
          check(!response || response.status === 429 || response.status >= 500,
            `Webhook rejected with HTTP ${response?.status}; check web URL and dummy secret.`);
          check(attempt < 3, "Webhook still failing after four attempts; inspect load web logs.");
          result.retries++;
          await sleep(500 * 2 ** attempt);
        }
      } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return result;
}

export function checkCampaignOrder(order, shop, count) {
  const id = Number(order.shopifyOrderId.split("/").at(-1));
  const protectedOrder = id % 2 === 0;
  check(Number.isSafeInteger(id) && id >= 1 && id <= count && order.shopifyOrderId === `gid://shopify/Order/${id}` &&
    order.name === `#LOAD-${shop}-${id}` && order.firstPaidAt && order.paidEligible &&
    order.currencyCode === "AUD" && Number(order.totalAmount) === (protectedOrder ? 102 : 100) &&
    order.paidProtected === protectedOrder && Number(order.paidProtectionFee) === (protectedOrder ? 2 : 0),
  `Order snapshot mismatch for ${shop}, order ${id}.`);
  const purchase = order.protectionPurchase;
  check(protectedOrder ? purchase?.purchasedAt && purchase.currencyCode === "AUD" && Number(purchase.feeAmount) === 2 &&
    purchase.attributionStatus === "ATTRIBUTED" && purchase.pricingCheck === "MATCHED" : !purchase,
  `Purchase mismatch for ${shop}, order ${id}.`);
  check(order.protectionRefunds.length === (id % 10 === 0 ? 1 : 0), `Refund count mismatch for ${shop}, order ${id}.`);
  for (const refund of order.protectionRefunds) {
    check(refund.shopifyRefundId === `gid://shopify/Refund/${id}` && refund.orderId === order.id &&
      refund.status === "CONFIRMED" && refund.currencyCode === "AUD" && Number(refund.amount) === 2,
    `Refund mismatch for ${shop}, order ${id}.`);
  }
}

export async function verifyCampaign(database, shops, config) {
  for (const shop of shops) {
    let cursor, seen = 0, more = true;
    // Bounded pages rather than holding millions of orders or IDs in memory.
    while (more) {
      const orders = await database.order.findMany({ where: { shopId: shop.id }, take: 500,
        orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { protectionPurchase: true, protectionRefunds: true } });
      if (!orders.length) break;
      for (const order of orders) checkCampaignOrder(order, shop.shopDomain, config.orders);
      seen += orders.length;
      cursor = orders.at(-1).id;
      more = orders.length === 500;
    }
    // Unique (shopId, shopifyOrderId), range checks and exact cardinality prove set equality.
    check(seen === config.orders, `Expected ${config.orders} orders for ${shop.shopDomain}, found ${seen}.`);
    check(await database.protectionPurchase.count({ where: { shopId: shop.id } }) === Math.floor(config.orders / 2),
      `Extra or missing purchases for ${shop.shopDomain}.`);
    check(await database.protectionRefund.count({ where: { shopId: shop.id } }) === Math.floor(config.orders / 10),
      `Extra or missing refunds for ${shop.shopDomain}.`);
  }
  return { orders: config.orders * shops.length, purchases: Math.floor(config.orders / 2) * shops.length,
    purchaseAud: Math.floor(config.orders / 2) * 2 * shops.length,
    refunds: Math.floor(config.orders / 10) * shops.length, refundAud: Math.floor(config.orders / 10) * 2 * shops.length };
}

async function waitForWorker(database, shops, config, run, deadline, report, armedAt = null) {
  const shopIds = shops.map((shop) => shop.id);
  const expected = config.shops * (2 * config.orders + Math.floor(config.orders / 10));
  while (Date.now() < deadline) {
    const statuses = await database.webhookDelivery.groupBy({ by: ["status"], where: { shopId: { in: shopIds } }, _count: true });
    const counts = Object.fromEntries(statuses.map((row) => [row.status, row._count]));
    check(!counts.FAILED, "Worker reported terminal failures; inspect the retained campaign shops and logs.");
    const backlog = (counts.PENDING ?? 0) + (counts.PROCESSING ?? 0);
    report.maxObservedBacklog = Math.max(report.maxObservedBacklog ?? 0, backlog);
    process.stdout.write(`${config.mode}: processed=${counts.PROCESSED ?? 0}, backlog=${backlog}\n`);
    if (config.mode === "burst") {
      const processed = await database.webhookDelivery.count({ where: { shopId: { in: shopIds }, webhookId: { startsWith: run }, status: "PROCESSED" } });
      if (processed === expected && backlog === 0) return;
    } else {
      const complete = await database.shop.count({ where: { id: { in: shopIds }, orderReconciliationSince: { gte: armedAt },
        orderReconciliationCursor: null, orderReconciliationUntil: null } });
      if (complete === shops.length && backlog === 0) return;
    }
    await pause(5000);
  }
  throw new CampaignError("Campaign timeout waiting for the worker. Records remain available for inspection; use a new shop range for another run.");
}

export async function runCampaign(database, config, report) {
  const health = await fetch(`${config.origin}/healthz`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  check(health.ok, `Load web health returned HTTP ${health.status}.`);
  await health.body?.cancel();
  const domains = Array.from({ length: config.shops }, (_, offset) => shopDomain(config.shopStart + offset));
  check(!await database.shop.findFirst({ where: { shopDomain: { in: domains } }, select: { id: true } }),
    "Campaign requires fresh shops. Increase LOAD_SHOP_START; no existing records are deleted.");
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  // Freeze discovery throughout burst and seeding, so discovery cannot conceal lost webhooks.
  const watermark = new Date(deadline + 86_400_000);
  const shops = [];
  report.shops = domains;
  report.seededShops = [];
  for (const shop of domains) {
    shops.push(await seedLoadShop(database, { ...config, shop }, { fresh: true, watermark }));
    report.seededShops.push(shop);
  }
  process.stdout.write(`Seeded ${shops.length} fresh shops; expecting ${config.orders} orders per shop.\n`);
  if (config.mode === "burst") {
    const sentAt = Date.now();
    report.http = httpMetrics();
    try { await sendCampaignEvents(config, campaignEvents(config, report.run), fetch, pause, deadline, report.http); }
    finally { report.submissionSeconds = (Date.now() - sentAt) / 1000; }
    const drainAt = Date.now();
    await waitForWorker(database, shops, config, report.run, deadline, report);
    report.drainAfterSubmissionSeconds = (Date.now() - drainAt) / 1000;
  } else {
    // Repeat discovery to prove re-reading the same authoritative records doesn't double count.
    report.passes = [];
    for (let pass = 1; pass <= 2; pass++) {
      const armedAt = new Date();
      await database.shop.updateMany({ where: { id: { in: shops.map((shop) => shop.id) } },
        data: { orderReconciliationSince: null, orderReconciliationCursor: null, orderReconciliationUntil: null } });
      await waitForWorker(database, shops, config, report.run, deadline, report, armedAt);
      const totals = await verifyCampaign(database, shops, config);
      report.passes.push({ pass, seconds: (Date.now() - armedAt.getTime()) / 1000, totals });
    }
  }
  report.totals = await verifyCampaign(database, shops, config);
  // Keep burst shops frozen for inspection. Reconciliation shops keep their completed watermark.
  process.stdout.write(`PASS: ${JSON.stringify(report.totals)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let database;
  const report = { run: `campaign-${randomUUID()}`, startedAt: new Date().toISOString(), status: "FAIL" };
  try {
    const config = campaignConfig(process.argv[2]);
    report.config = { mode: config.mode, shopStart: config.shopStart, shops: config.shops, orders: config.orders,
      concurrency: config.concurrency, timeoutSeconds: config.timeoutSeconds };
    const { PrismaClient } = await import("@prisma/client");
    database = new PrismaClient();
    await runCampaign(database, config, report);
    report.status = "PASS";
  } catch (error) {
    report.error = error instanceof CampaignError || error instanceof SmokeError ? error.message : "Database or network operation failed; check load variables and service logs.";
    process.stderr.write(`FAIL: ${report.error}\n`);
    process.exitCode = 1;
  } finally {
    if (database) await database.$disconnect();
    report.finishedAt = new Date().toISOString();
    await mkdir(".load-results", { recursive: true });
    const file = `.load-results/${report.run}.json`;
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Report: ${file}\n`);
  }
}
