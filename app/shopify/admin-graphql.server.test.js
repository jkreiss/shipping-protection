import { afterEach, describe, expect, test, vi } from "vitest";
import process from "node:process";
import { adminGraphql, isAccessLost } from "./admin-graphql.server";

const QUERY = `#graphql
  query ShopName { shop { name } }
`;

function cost({ requested = 10, actual = requested, available = 990, maximum = 1000, restoreRate = 50 } = {}) {
  return {
    requestedQueryCost: requested,
    actualQueryCost: actual,
    throttleStatus: { maximumAvailable: maximum, currentlyAvailable: available, restoreRate },
  };
}

// Shape of the error @shopify/shopify-api throws when Shopify answers 200 with GraphQL errors.
function throttledError(extensionsCost) {
  const error = new Error("Throttled");
  error.body = {
    extensions: { cost: extensionsCost },
    errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
  };
  return error;
}

function fakeAdmin(responses) {
  const calls = [];
  return {
    calls,
    graphql: async (query, options) => {
      // GraphQL comments run to end of line, as Shopify parses them.
      if (!query.replace(/#[^\n]*/g, "").trim()) throw new Error("syntax error, unexpected end of file");
      calls.push(options?.variables);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("load environment isolation", () => {
  test("refuses an override outside the load environment", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", "http://localhost:4010");
    const admin = fakeAdmin([{ data: { shop: { name: "Real" } } }]);
    await expect(adminGraphql(admin, QUERY, {}, { shop: "load-1.myshopify.com" })).rejects.toThrow(/load/);
  });

  test("load mode without a mock never falls through to Shopify", async () => {
    vi.stubEnv("APP_ENV", "load");
    vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", "");
    await expect(adminGraphql(fakeAdmin([{ data: {} }]), QUERY)).rejects.toThrow(/MOCK_URL/);
  });
});

describe("adminGraphql throttling", () => {
  test("waits for the bucket to refill and retries a throttled query", async () => {
    const admin = fakeAdmin([
      throttledError(cost({ requested: 200, actual: 0, available: 100, restoreRate: 50 })),
      { data: { shop: { name: "Store" } }, extensions: { cost: cost() } },
    ]);
    const waits = [];

    const data = await adminGraphql(admin, QUERY, {}, { shop: "retry.myshopify.com", sleep: async (ms) => { waits.push(ms); } });

    expect(data).toEqual({ shop: { name: "Store" } });
    expect(admin.calls).toHaveLength(2);
    // (200 requested - 100 available) / 50 points per second
    expect(waits).toEqual([2000]);
  });

  test("retries a throttled payload returned without throwing", async () => {
    const admin = fakeAdmin([
      { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: cost({ available: 0 }) } },
      { data: { shop: { name: "Store" } } },
    ]);

    const data = await adminGraphql(admin, QUERY, {}, { sleep: async () => {} });

    expect(data).toEqual({ shop: { name: "Store" } });
  });

  test("gives up after three throttled retries", async () => {
    const admin = fakeAdmin([1, 2, 3, 4].map(() => throttledError(cost({ available: 0 }))));

    await expect(adminGraphql(admin, QUERY, {}, { sleep: async () => {} })).rejects.toThrow("Throttled");
    expect(admin.calls).toHaveLength(4);
  });

  test("logs a lost-access 401 without reporting a failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const unauthorized = Object.assign(new Error("Unauthorized"), { response: { code: 401 } });
    const admin = fakeAdmin([unauthorized]);

    await expect(adminGraphql(admin, QUERY, {}, { shop: "gone.myshopify.com" })).rejects.toBe(unauthorized);
    expect(isAccessLost(unauthorized)).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map(([line]) => JSON.parse(line).event)).toContain("shopify_access_lost");
  });

  test("does not retry other GraphQL errors", async () => {
    const admin = fakeAdmin([{ errors: [{ message: "Field 'nope' doesn't exist" }] }]);
    const sleep = vi.fn(async () => {});

    await expect(adminGraphql(admin, QUERY, {}, { sleep })).rejects.toThrow("Field 'nope' doesn't exist");
    expect(admin.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("paces the next query for a shop whose bucket is nearly empty", async () => {
    const shop = "pace.myshopify.com";
    const admin = fakeAdmin([
      { data: { shop: { name: "Store" } }, extensions: { cost: cost({ requested: 100, available: 50, restoreRate: 50 }) } },
      { data: { shop: { name: "Store" } }, extensions: { cost: cost() } },
    ]);
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };

    await adminGraphql(admin, QUERY, {}, { shop, sleep });
    expect(waits).toEqual([]);
    await adminGraphql(admin, QUERY, {}, { shop, sleep });

    // Keep two queries' worth (200) available: (200 - 50) / 50 = 3 seconds.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(2500);
    expect(waits[0]).toBeLessThanOrEqual(3000);
  });

  test("does not pace a different shop", async () => {
    const admin = fakeAdmin([
      { data: { shop: { name: "A" } }, extensions: { cost: cost({ requested: 100, available: 0 }) } },
      { data: { shop: { name: "B" } }, extensions: { cost: cost() } },
    ]);
    const sleep = vi.fn(async () => {});

    await adminGraphql(admin, QUERY, {}, { shop: "a.myshopify.com", sleep });
    await adminGraphql(admin, QUERY, {}, { shop: "b.myshopify.com", sleep });

    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("adminGraphql cost logging", () => {
  test("logs the operation's query cost without payload data", async () => {
    const writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
    const admin = fakeAdmin([
      { data: { shop: { name: "Secret Store" } }, extensions: { cost: cost({ requested: 12, actual: 4, available: 996 }) } },
    ]);

    await adminGraphql(admin, QUERY, {}, { shop: "log.myshopify.com" });

    const events = writes.map((line) => JSON.parse(line)).filter(({ event }) => event === "shopify_graphql_cost");
    expect(events).toEqual([expect.objectContaining({
      operation: "ShopName", shop: "log.myshopify.com",
      requestedQueryCost: 12, actualQueryCost: 4, currentlyAvailable: 996, restoreRate: 50,
    })]);
    expect(writes.join("")).not.toContain("Secret Store");
  });
});
