// Only server configuration can select this transport. No Shopify token is sent.
export function loadAdminConfig(env = process.env) {
  const origin = env.SHOPIFY_ADMIN_MOCK_URL;
  if (env.APP_ENV !== "load") {
    if (origin || env.SHOPIFY_ADMIN_MOCK_TOKEN) throw new Error("Shopify mock configuration requires APP_ENV=load.");
    return null;
  }
  if (!origin || !env.SHOPIFY_ADMIN_MOCK_TOKEN) {
    throw new Error("APP_ENV=load requires SHOPIFY_ADMIN_MOCK_URL and SHOPIFY_ADMIN_MOCK_TOKEN.");
  }
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash || /(^|\.)myshopify\.com$/i.test(url.hostname)) {
    throw new Error("SHOPIFY_ADMIN_MOCK_URL must be a mock HTTP(S) origin.");
  }
  return { origin: url.origin, token: env.SHOPIFY_ADMIN_MOCK_TOKEN };
}

export async function loadAdminGraphql(config, shop, query, variables, signal = undefined) {
  if (!/^load-[1-9]\d*\.myshopify\.com$/.test(shop ?? "")) {
    throw new Error("Load Admin API requires a fake load-N.myshopify.com tenant.");
  }
  const response = await fetch(`${config.origin}/shops/${shop}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  // Let the worker's existing durable retry/backoff handle HTTP failures.
  if (!response.ok) throw new Error(`Mock Shopify Admin HTTP ${response.status}.`);
  return response;
}
