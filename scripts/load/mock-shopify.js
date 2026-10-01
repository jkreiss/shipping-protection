import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { generatedOrder } from "./dataset.js";

const defaults = { shops: 1, ordersPerShop: 200_000, intervalMs: 1000,
  latencyMs: 100, jitterMs: 100, http429Every: 0, http500Every: 0, throttleEvery: 0 };
const hash = (value) => createHash("sha256").update(value).digest();

function settings(options) {
  const config = { ...defaults, ...options };
  if (!config.token || !Number.isFinite(Date.parse(config.startAt))) {
    throw new Error("Mock requires a token and a valid startAt timestamp.");
  }
  for (const key of Object.keys(defaults)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (["shops", "ordersPerShop", "intervalMs"].includes(key) ? 1 : 0)) {
      throw new Error(`Invalid mock setting: ${key}.`);
    }
  }
  if (config.shops > 10_000 || config.ordersPerShop > 10_000_000 || config.latencyMs + config.jitterMs > 25_000 ||
    !Number.isFinite(new Date(Date.parse(config.startAt) + (config.ordersPerShop - 1) * config.intervalMs).getTime())) {
    throw new Error("Mock settings exceed supported limits.");
  }
  return config;
}

function cost(throttled = false) {
  return { cost: { requestedQueryCost: 10, actualQueryCost: throttled ? 0 : 10,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: throttled ? 0 : 990, restoreRate: 100 } } };
}

function windowBounds(query) {
  // Exactly the search contract emitted by reconciliation; never silently ignore filters.
  const match = typeof query === "string" && query.match(/^updated_at:>='([^']+)' updated_at:<='([^']+)'$/);
  if (!match || !Number.isFinite(Date.parse(match[1])) || !Number.isFinite(Date.parse(match[2]))) {
    throw new Error("Unsupported reconciliation search window.");
  }
  return [Date.parse(match[1]), Date.parse(match[2])];
}

function execute(query, variables, shop, config) {
  const operation = typeof query === "string" && query.replace(/#[^\n]*/g, "").match(/^\s*query\s+(\w+)/)?.[1];
  if (operation === "AnalyticsShop") return { shop: { currencyCode: "AUD", ianaTimezone: "Australia/Sydney" } };
  if (["AnalyticsOrder", "OrderVersion"].includes(operation)) {
    const match = typeof variables.id === "string" && variables.id.match(/^gid:\/\/shopify\/Order\/([1-9]\d*)$/);
    if (!match) throw new Error("Invalid order ID.");
    const index = Number(match[1]);
    const order = index <= config.ordersPerShop ? generatedOrder(index, shop, config) : null;
    return { order: operation === "OrderVersion" && order ? { updatedAt: order.updatedAt } : order };
  }
  if (operation !== "ReconcileOrders") throw new Error("Unsupported mock operation.");
  const [since, until] = windowBounds(variables.query);
  if (!Number.isInteger(variables.first) || variables.first < 1 || variables.first > 250) throw new Error("Invalid page size.");
  const start = Date.parse(config.startAt);
  const lower = Math.max(1, Math.ceil((since - start) / config.intervalMs) + 1);
  const upper = Math.min(config.ordersPerShop, Math.floor((until - start) / config.intervalMs) + 1);
  let next = lower;
  if (variables.after != null) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(variables.after, "base64url").toString()); } catch { throw new Error("Invalid cursor."); }
    if (cursor.shop !== shop || cursor.since !== since || cursor.until !== until ||
      !Number.isSafeInteger(cursor.next) || cursor.next < lower || cursor.next > upper + 1) throw new Error("Invalid tenant or window cursor.");
    next = cursor.next;
  }
  const nodes = [];
  while (next <= upper && nodes.length < variables.first) {
    nodes.push({ id: `gid://shopify/Order/${next}`, updatedAt: new Date(start + (next - 1) * config.intervalMs).toISOString() });
    next += 1;
  }
  return { orders: { nodes, pageInfo: { hasNextPage: next <= upper,
    endCursor: nodes.length ? Buffer.from(JSON.stringify({ shop, since, until, next })).toString("base64url") : null } } };
}

export function createMockAdminServer(options) {
  const config = settings(options);
  const expectedAuth = hash(`Bearer ${config.token}`);
  const requests = new Map();
  function send(response, status, body, headers = {}) {
    response.writeHead(status, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  }
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { ok: true });
      if (!timingSafeEqual(expectedAuth, hash(request.headers.authorization ?? ""))) return send(response, 401, { error: "Unauthorized" });
      if (request.method === "GET" && request.url === "/stats") return send(response, 200, { requests: Object.fromEntries(requests) });
      const route = request.url?.match(/^\/shops\/(load-([1-9]\d*)\.myshopify\.com)\/graphql\.json$/);
      if (request.method !== "POST" || !route || Number(route[2]) > config.shops) return send(response, 404, { error: "Unknown mock tenant or route" });
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) { send(response, 413, { error: "Request too large" }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(response, 400, { error: "Invalid JSON" }); }
      if (!body || typeof body.query !== "string" || !body.variables || typeof body.variables !== "object" || Array.isArray(body.variables)) {
        return send(response, 400, { error: "Expected query and variables" });
      }
      const shop = route[1];
      const count = (requests.get(shop) ?? 0) + 1;
      requests.set(shop, count);
      await new Promise((resolve) => setTimeout(resolve, config.latencyMs + Math.floor(Math.random() * (config.jitterMs + 1))));
      if (config.http500Every && count % config.http500Every === 0) return send(response, 500, { errors: [{ message: "Injected failure" }] });
      if (config.http429Every && count % config.http429Every === 0) return send(response, 429, { errors: [{ message: "Injected rate limit" }] }, { "Retry-After": "1" });
      if (config.throttleEvery && count % config.throttleEvery === 0) {
        return send(response, 200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: cost(true) });
      }
      try { return send(response, 200, { data: execute(body.query, body.variables, shop, config), extensions: cost() }); }
      catch (error) { return send(response, 200, { errors: [{ message: error.message }] }); }
    } catch {
      if (!response.headersSent) send(response, 400, { error: "Invalid request" });
      else response.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.APP_ENV !== "load") throw new Error("Mock server requires APP_ENV=load.");
  const options = { token: process.env.SHOPIFY_ADMIN_MOCK_TOKEN, startAt: process.env.MOCK_START_AT };
  for (const key of Object.keys(defaults)) {
    const name = `MOCK_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
    if (process.env[name] !== undefined) options[key] = Number(process.env[name]);
  }
  const server = createMockAdminServer(options);
  const port = Number(process.env.PORT ?? 4010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  server.listen(port, process.env.MOCK_HOST ?? "0.0.0.0", () => {
    process.stdout.write(`${JSON.stringify({ event: "mock_shopify_ready", port })}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    server.close();
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
}
