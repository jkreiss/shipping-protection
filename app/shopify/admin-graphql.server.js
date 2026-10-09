import { setTimeout as delay } from "node:timers/promises";
import { settingsLeaseContext } from "../settings-lease-context.server.js";
import { logEvent, reportFailure } from "../observability.server.js";
import { loadAdminConfig, loadAdminGraphql } from "./load-admin.server.js";

const MAX_THROTTLE_RETRIES = 3;
const MAX_WAIT_MS = 30_000;
// Leave room for about two more queries of the same cost before pausing a shop.
const PACE_HEADROOM = 2;

// When each shop's cost bucket can take the next query. In-process only, so
// the worker's parallel loops share one budget per shop.
const shopReadyAt = new Map();

const defaultSleep = (ms, signal = undefined) =>
  delay(ms, undefined, { signal });

function graphqlErrors(source) {
  if (Array.isArray(source?.errors)) return source.errors;
  // @shopify/shopify-api throws GraphqlQueryError with the response in `body`.
  return source?.body?.errors?.graphQLErrors ?? [];
}

function isThrottled(source) {
  return graphqlErrors(source).some(
    (error) => error?.extensions?.code === "THROTTLED",
  );
}

function refillMs(cost, needed) {
  const status = cost?.throttleStatus;
  if (
    !Number.isFinite(status?.restoreRate) ||
    status.restoreRate <= 0 ||
    !Number.isFinite(status.currentlyAvailable) ||
    !Number.isFinite(needed)
  )
    return null;
  const missing = Math.max(0, needed - status.currentlyAvailable);
  return Math.min(
    MAX_WAIT_MS,
    Math.ceil((missing / status.restoreRate) * 1000),
  );
}

function logCost(operation, shop, cost) {
  const status = cost?.throttleStatus;
  if (!status) return;
  logEvent("shopify_graphql_cost", {
    operation,
    shop,
    requestedQueryCost: cost.requestedQueryCost,
    actualQueryCost: cost.actualQueryCost,
    currentlyAvailable: status.currentlyAvailable,
    maximumAvailable: status.maximumAvailable,
    restoreRate: status.restoreRate,
  });
}

function paceShop(shop, cost) {
  if (!shop || !cost?.throttleStatus) return;
  const waitMs = refillMs(cost, PACE_HEADROOM * (cost.requestedQueryCost ?? 0));
  if (waitMs > 0) extendDeadline(shop, waitMs);
}

function extendDeadline(shop, waitMs) {
  if (shop)
    shopReadyAt.set(
      shop,
      Math.max(shopReadyAt.get(shop) ?? 0, Date.now() + waitMs),
    );
}

async function waitForShop(shop, sleep) {
  // Siblings can keep extending the deadline; stop waiting after MAX_WAIT_MS.
  const until = Date.now() + MAX_WAIT_MS;
  let now;
  while (
    shop &&
    (now = Date.now()) < until &&
    (shopReadyAt.get(shop) ?? 0) > now
  ) {
    await sleep(Math.min(shopReadyAt.get(shop), until) - now);
  }
  if (shop && (shopReadyAt.get(shop) ?? 0) <= Date.now())
    shopReadyAt.delete(shop);
}

async function throttleBackoff(shop, cost, attempt, sleep) {
  const delay =
    refillMs(cost, cost?.requestedQueryCost ?? 0) || 1000 * 2 ** attempt;
  extendDeadline(shop, delay);
  if (attempt < MAX_THROTTLE_RETRIES) {
    if (shop) await waitForShop(shop, sleep);
    else await sleep(delay);
  }
}

// The app no longer has access to the shop: no offline session, or Shopify
// rejected the token. The uninstall webhook follows, so this is not a failure.
export function isAccessLost(error) {
  return (
    error?.constructor?.name === "SessionNotFoundError" ||
    error?.response?.code === 401
  );
}

export async function adminGraphql(
  admin,
  query,
  variables = {},
  { shop, sleep = defaultSleep } = {},
) {
  const lease = settingsLeaseContext.getStore();
  if (lease && shop && shop !== lease.shopDomain)
    throw new Error("Settings tenant mismatch.");
  shop ??= lease?.shopDomain;
  const wait = async (ms) => {
    await sleep(ms, lease?.signal);
    lease?.signal.throwIfAborted();
  };
  const operation =
    query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z_0-9]*)/)?.[1] ??
    "anonymous";
  try {
    const mock = loadAdminConfig();
    for (let attempt = 0; ; attempt += 1) {
      await waitForShop(shop, wait);
      await lease?.assertHeld();
      let payload;
      try {
        const response = mock
          ? await loadAdminGraphql(mock, shop, query, variables, lease?.signal)
          : await admin.graphql(query, {
              variables,
              ...(lease ? { signal: lease.signal } : {}),
            });
        payload = await response.json();
      } catch (error) {
        if (!isThrottled(error)) throw error;
        const cost = error.body?.extensions?.cost;
        logCost(operation, shop, cost);
        await throttleBackoff(shop, cost, attempt, wait);
        if (attempt >= MAX_THROTTLE_RETRIES) throw error;
        continue;
      }
      const cost = payload.extensions?.cost;
      logCost(operation, shop, cost);
      if (isThrottled(payload)) {
        await throttleBackoff(shop, cost, attempt, wait);
        if (attempt < MAX_THROTTLE_RETRIES) continue;
      } else paceShop(shop, cost);
      if (payload.errors?.length) {
        throw new Error(
          payload.errors.map(({ message }) => message).join("; "),
        );
      }
      const searchWarnings = Array.isArray(payload.extensions?.search)
        ? payload.extensions.search.flatMap(({ warnings }) => warnings ?? [])
        : [];
      if (searchWarnings.length) {
        throw new Error(
          `Shopify search warning: ${searchWarnings.map(({ message }) => message).join("; ")}`,
        );
      }
      if (!payload.data) throw new Error("Shopify returned no GraphQL data.");
      return payload.data;
    }
  } catch (error) {
    // withShopSettingsLock already reported the lease loss.
    if (lease?.signal.aborted) throw lease.signal.reason;
    if (isAccessLost(error))
      logEvent("shopify_access_lost", { operation, shop });
    else reportFailure("shopify_graphql_failed", error, { operation });
    throw error;
  }
}

export function assertUserErrors(payload, operation) {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      errors
        .map(
          ({ field, message }) =>
            `${field?.join(".") || operation}: ${message}`,
        )
        .join("; "),
    );
  }
}
