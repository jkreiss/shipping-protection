import { logEvent, reportFailure } from "../observability.server.js";
import { loadAdminConfig, loadAdminGraphql } from "./load-admin.server.js";

const MAX_THROTTLE_RETRIES = 3;
const MAX_WAIT_MS = 30_000;
// Leave room for about two more queries of the same cost before pausing a shop.
const PACE_HEADROOM = 2;

// When each shop's cost bucket can take the next query. In-process only, so
// the worker's parallel loops share one budget per shop.
const shopReadyAt = new Map();

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function graphqlErrors(source) {
  if (Array.isArray(source?.errors)) return source.errors;
  // @shopify/shopify-api throws GraphqlQueryError with the response in `body`.
  return source?.body?.errors?.graphQLErrors ?? [];
}

function isThrottled(source) {
  return graphqlErrors(source).some((error) => error?.extensions?.code === "THROTTLED");
}

function refillMs(cost, needed) {
  const status = cost?.throttleStatus;
  if (!status?.restoreRate) return null;
  const missing = Math.max(0, needed - status.currentlyAvailable);
  return Math.min(MAX_WAIT_MS, Math.ceil((missing / status.restoreRate) * 1000));
}

function logCost(operation, shop, cost) {
  const status = cost?.throttleStatus;
  if (!status) return;
  logEvent("shopify_graphql_cost", {
    operation, shop,
    requestedQueryCost: cost.requestedQueryCost, actualQueryCost: cost.actualQueryCost,
    currentlyAvailable: status.currentlyAvailable, maximumAvailable: status.maximumAvailable,
    restoreRate: status.restoreRate,
  });
}

function paceShop(shop, cost) {
  if (!shop || !cost?.throttleStatus) return;
  const waitMs = refillMs(cost, PACE_HEADROOM * (cost.requestedQueryCost ?? 0));
  if (waitMs > 0) shopReadyAt.set(shop, Date.now() + waitMs);
  else shopReadyAt.delete(shop);
}

async function waitForShop(shop, sleep) {
  const readyAt = shop ? shopReadyAt.get(shop) : undefined;
  if (readyAt && readyAt > Date.now()) await sleep(readyAt - Date.now());
}

export async function adminGraphql(admin, query, variables = {}, { shop, sleep = defaultSleep } = {}) {
  const operation = query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z_0-9]*)/)?.[1] ?? "anonymous";
  try {
    const mock = loadAdminConfig();
    for (let attempt = 0; ; attempt += 1) {
      await waitForShop(shop, sleep);
      let payload;
      try {
        const response = mock
          ? await loadAdminGraphql(mock, shop, query, variables)
          : await admin.graphql(query, { variables });
        payload = await response.json();
      } catch (error) {
        if (!isThrottled(error) || attempt >= MAX_THROTTLE_RETRIES) throw error;
        const cost = error.body?.extensions?.cost;
        logCost(operation, shop, cost);
        await sleep(refillMs(cost, cost?.requestedQueryCost ?? 0) || 1000 * 2 ** attempt);
        continue;
      }
      const cost = payload.extensions?.cost;
      logCost(operation, shop, cost);
      if (isThrottled(payload) && attempt < MAX_THROTTLE_RETRIES) {
        await sleep(refillMs(cost, cost?.requestedQueryCost ?? 0) || 1000 * 2 ** attempt);
        continue;
      }
      paceShop(shop, cost);
      if (payload.errors?.length) {
        throw new Error(payload.errors.map(({ message }) => message).join("; "));
      }
      const searchWarnings = Array.isArray(payload.extensions?.search)
        ? payload.extensions.search.flatMap(({ warnings }) => warnings ?? [])
        : [];
      if (searchWarnings.length) {
        throw new Error(`Shopify search warning: ${searchWarnings.map(({ message }) => message).join("; ")}`);
      }
      if (!payload.data) throw new Error("Shopify returned no GraphQL data.");
      return payload.data;
    }
  } catch (error) {
    reportFailure("shopify_graphql_failed", error, { operation });
    throw error;
  }
}

export function assertUserErrors(payload, operation) {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map(({ field, message }) =>
      `${field?.join(".") || operation}: ${message}`).join("; "));
  }
}
