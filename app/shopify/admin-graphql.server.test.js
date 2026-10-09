import { afterEach, describe, expect, test, vi } from "vitest";
import process from "node:process";
import { adminGraphql, isAccessLost } from "./admin-graphql.server";
import { settingsLeaseContext } from "../settings-lease-context.server";
import { UserFacingError } from "../user-facing-error";

const QUERY = `#graphql
  query ShopName { shop { name } }
`;

function cost({
  requested = 10,
  actual = requested,
  available = 990,
  maximum = 1000,
  restoreRate = 50,
} = {}) {
  return {
    requestedQueryCost: requested,
    actualQueryCost: actual,
    throttleStatus: {
      maximumAvailable: maximum,
      currentlyAvailable: available,
      restoreRate,
    },
  };
}

// Shape of the error @shopify/shopify-api throws when Shopify answers 200 with GraphQL errors.
function throttledError(extensionsCost) {
  const error = new Error("Throttled");
  error.body = {
    extensions: { cost: extensionsCost },
    errors: {
      graphQLErrors: [
        { message: "Throttled", extensions: { code: "THROTTLED" } },
      ],
    },
  };
  return error;
}

function fakeAdmin(responses) {
  const calls = [];
  return {
    calls,
    graphql: async (query, options) => {
      // GraphQL comments run to end of line, as Shopify parses them.
      if (!query.replace(/#[^\n]*/g, "").trim())
        throw new Error("syntax error, unexpected end of file");
      calls.push(options?.variables);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("load environment isolation", () => {
  test("refuses an override outside the load environment", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", "http://localhost:4010");
    const admin = fakeAdmin([{ data: { shop: { name: "Real" } } }]);
    await expect(
      adminGraphql(admin, QUERY, {}, { shop: "load-1.myshopify.com" }),
    ).rejects.toThrow(/load/);
  });

  test("load mode without a mock never falls through to Shopify", async () => {
    vi.stubEnv("APP_ENV", "load");
    vi.stubEnv("SHOPIFY_ADMIN_MOCK_URL", "");
    await expect(
      adminGraphql(fakeAdmin([{ data: {} }]), QUERY),
    ).rejects.toThrow(/MOCK_URL/);
  });
});

describe("adminGraphql throttling", () => {
  test("waits for the bucket to refill and retries a throttled query", async () => {
    vi.useFakeTimers();
    const admin = fakeAdmin([
      throttledError(
        cost({ requested: 200, actual: 0, available: 100, restoreRate: 50 }),
      ),
      { data: { shop: { name: "Store" } }, extensions: { cost: cost() } },
    ]);
    const waits = [];

    const data = await adminGraphql(
      admin,
      QUERY,
      {},
      {
        shop: "retry.myshopify.com",
        sleep: async (ms) => {
          waits.push(ms);
          vi.setSystemTime(Date.now() + ms);
        },
      },
    );

    expect(data).toEqual({ shop: { name: "Store" } });
    expect(admin.calls).toHaveLength(2);
    // (200 requested - 100 available) / 50 points per second
    expect(waits).toEqual([2000]);
  });

  test("retries a throttled payload returned without throwing", async () => {
    const admin = fakeAdmin([
      {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: cost({ available: 0 }) },
      },
      { data: { shop: { name: "Store" } } },
    ]);

    const data = await adminGraphql(
      admin,
      QUERY,
      {},
      { sleep: async () => {} },
    );

    expect(data).toEqual({ shop: { name: "Store" } });
  });

  test("gives up after three throttled retries", async () => {
    const admin = fakeAdmin(
      [1, 2, 3, 4].map(() => throttledError(cost({ available: 0 }))),
    );

    await expect(
      adminGraphql(admin, QUERY, {}, { sleep: async () => {} }),
    ).rejects.toThrow("Throttled");
    expect(admin.calls).toHaveLength(4);
  });

  test("logs a lost-access 401 without reporting a failure", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      response: { code: 401 },
    });
    const admin = fakeAdmin([unauthorized]);

    await expect(
      adminGraphql(admin, QUERY, {}, { shop: "gone.myshopify.com" }),
    ).rejects.toBe(unauthorized);
    expect(isAccessLost(unauthorized)).toBe(true);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map(([line]) => JSON.parse(line).event)).toContain(
      "shopify_access_lost",
    );
  });

  test("does not retry other GraphQL errors", async () => {
    const admin = fakeAdmin([
      { errors: [{ message: "Field 'nope' doesn't exist" }] },
    ]);
    const sleep = vi.fn(async () => {});

    await expect(adminGraphql(admin, QUERY, {}, { sleep })).rejects.toThrow(
      "Field 'nope' doesn't exist",
    );
    expect(admin.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("paces the next query for a shop whose bucket is nearly empty", async () => {
    vi.useFakeTimers();
    const shop = "pace.myshopify.com";
    const admin = fakeAdmin([
      {
        data: { shop: { name: "Store" } },
        extensions: {
          cost: cost({ requested: 100, available: 50, restoreRate: 50 }),
        },
      },
      { data: { shop: { name: "Store" } }, extensions: { cost: cost() } },
    ]);
    const waits = [];
    const sleep = async (ms) => {
      waits.push(ms);
      vi.setSystemTime(Date.now() + ms);
    };

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
      {
        data: { shop: { name: "A" } },
        extensions: { cost: cost({ requested: 100, available: 0 }) },
      },
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
    vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      writes.push(String(line));
      return true;
    });
    const admin = fakeAdmin([
      {
        data: { shop: { name: "Secret Store" } },
        extensions: {
          cost: cost({ requested: 12, actual: 4, available: 996 }),
        },
      },
    ]);

    await adminGraphql(admin, QUERY, {}, { shop: "log.myshopify.com" });

    const events = writes
      .map((line) => JSON.parse(line))
      .filter(({ event }) => event === "shopify_graphql_cost");
    expect(events).toEqual([
      expect.objectContaining({
        operation: "ShopName",
        shop: "log.myshopify.com",
        requestedQueryCost: 12,
        actualQueryCost: 4,
        currentlyAvailable: 996,
        restoreRate: 50,
      }),
    ]);
    expect(writes.join("")).not.toContain("Secret Store");
  });
});

// These sleepers advance the clock just like real timers, while controlled
// barriers keep sibling requests in flight at the same time.
describe("shared throttle deadlines", () => {
  test.each(["thrown", "returned"])(
    "%s terminal throttling delays a sibling",
    async (shape) => {
      vi.useFakeTimers();
      const c = cost({ requested: 200, available: 0, restoreRate: 50 });
      const throttle = () =>
        shape === "thrown"
          ? throttledError(c)
          : {
              errors: [
                { message: "Throttled", extensions: { code: "THROTTLED" } },
              ],
              extensions: { cost: c },
            };
      const shop = `terminal-${shape}.myshopify.com`;
      const sleep = async (ms) => {
        vi.setSystemTime(Date.now() + ms);
      };
      await expect(
        adminGraphql(
          fakeAdmin([1, 2, 3, 4].map(throttle)),
          QUERY,
          {},
          { shop, sleep },
        ),
      ).rejects.toThrow("Throttled");
      const waits = [];
      await adminGraphql(
        fakeAdmin([{ data: {} }]),
        QUERY,
        {},
        {
          shop,
          sleep: async (ms) => {
            waits.push(ms);
            await sleep(ms);
          },
        },
      );
      expect(waits).toEqual([4000]);
    },
  );

  test("a stale success cannot erase a sibling deadline and sleeping rechecks extensions", async () => {
    vi.useFakeTimers();
    const shop = "monotonic.myshopify.com";
    let finish;
    const old = adminGraphql(
      {
        graphql: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      QUERY,
      {},
      { shop },
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const low = () =>
      adminGraphql(
        fakeAdmin([
          {
            data: {},
            extensions: { cost: cost({ requested: 100, available: 0 }) },
          },
        ]),
        QUERY,
        {},
        {
          shop,
          sleep: async (ms) => {
            vi.setSystemTime(Date.now() + ms);
          },
        },
      );
    await low();
    finish({ json: async () => ({ data: {}, extensions: { cost: cost() } }) });
    await old;
    const waits = [];
    await adminGraphql(
      fakeAdmin([{ data: {} }]),
      QUERY,
      {},
      {
        shop,
        sleep: async (ms) => {
          waits.push(ms);
          vi.setSystemTime(Date.now() + ms);
          if (waits.length === 1) await low();
        },
      },
    );
    expect(waits).toEqual([4000, 4000]);
  });
});

describe("throttle siblings and fallback", () => {
  test.each(["thrown", "returned"])(
    "%s response immediately pauses an in-flight sibling",
    async (shape) => {
      vi.useFakeTimers();
      const shop = `inflight-${shape}.myshopify.com`;
      const c = cost({ requested: 200, available: 0 });
      const throttle =
        shape === "thrown"
          ? throttledError(c)
          : {
              errors: [
                { message: "Throttled", extensions: { code: "THROTTLED" } },
              ],
              extensions: { cost: c },
            };
      let resume;
      const sleeps = [];
      const sleep = (ms) => {
        sleeps.push(ms);
        return new Promise((resolve) => {
          resume = resolve;
        });
      };
      const first = adminGraphql(
        fakeAdmin([throttle, { data: {} }]),
        QUERY,
        {},
        { shop, sleep },
      );
      await vi.waitFor(() => expect(sleeps).toHaveLength(1));
      const sibling = fakeAdmin([{ data: {} }]);
      let resumeSibling;
      const second = adminGraphql(
        sibling,
        QUERY,
        {},
        {
          shop,
          sleep: async (ms) => {
            expect(ms).toBeGreaterThan(3500);
            expect(ms).toBeLessThanOrEqual(4000);
            await new Promise((resolve) => {
              resumeSibling = resolve;
            });
          },
        },
      );
      await vi.waitFor(() => expect(resumeSibling).toBeTypeOf("function"));
      expect(sibling.calls).toHaveLength(0);
      await adminGraphql(
        fakeAdmin([{ data: {} }]),
        QUERY,
        {},
        {
          shop: `${shop}-other`,
          sleep: async () => {
            throw new Error("Tenant leaked");
          },
        },
      );
      vi.setSystemTime(Date.now() + 4000);
      resume();
      resumeSibling();
      await Promise.all([first, second]);
      expect(sibling.calls).toHaveLength(1);
    },
  );

  test.each([undefined, cost({ restoreRate: 0 })])(
    "missing or unusable capacity uses exponential fallback",
    async (c) => {
      const waits = [];
      await expect(
        adminGraphql(
          fakeAdmin([1, 2, 3, 4].map(() => throttledError(c))),
          QUERY,
          {},
          {
            sleep: async (ms) => {
              waits.push(ms);
            },
          },
        ),
      ).rejects.toThrow("Throttled");
      expect(waits).toEqual([1000, 2000, 4000]);
    },
  );

  test("a refill wait is capped at thirty seconds", async () => {
    const waits = [];
    await adminGraphql(
      fakeAdmin([
        throttledError(cost({ requested: 1000, available: 0, restoreRate: 1 })),
        { data: {} },
      ]),
      QUERY,
      {},
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(waits).toEqual([30_000]);
  });
});

describe("shop wait cap", () => {
  test("siblings that keep extending the deadline cannot hold a call past thirty seconds", async () => {
    vi.useFakeTimers();
    const shop = "capped.myshopify.com";
    const gates = [];
    const siblings = Array.from({ length: 5 }, () =>
      adminGraphql(
        { graphql: () => new Promise((resolve) => gates.push(resolve)) },
        QUERY,
        {},
        { shop },
      ),
    );
    await vi.waitFor(() => expect(gates).toHaveLength(5));
    const expensive = {
      json: async () => ({
        data: {},
        extensions: {
          cost: cost({ requested: 1000, available: 0, restoreRate: 100 }),
        },
      }),
    };
    gates.shift()(expensive);
    await siblings.shift();
    const waits = [];
    const data = await adminGraphql(
      fakeAdmin([{ data: { ok: true } }]),
      QUERY,
      {},
      {
        shop,
        sleep: async (ms) => {
          waits.push(ms);
          vi.setSystemTime(Date.now() + ms);
          gates.shift()?.(expensive);
          await siblings.shift();
        },
      },
    );
    expect(data).toEqual({ ok: true });
    expect(waits.reduce((total, ms) => total + ms, 0)).toBe(30_000);
  });
});

describe("settings lease loss during a wait", () => {
  test("surfaces the lease error and does not report a Shopify failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const controller = new AbortController();
    const lost = new UserFacingError("This settings change was interrupted.");
    const lease = {
      shopDomain: "lease.myshopify.com",
      signal: controller.signal,
      assertHeld: async () => {},
    };
    const sleep = (_ms, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
        controller.abort(lost);
      });
    const throttled = throttledError(cost({ requested: 200, available: 0 }));
    await expect(
      settingsLeaseContext.run(lease, () =>
        adminGraphql(fakeAdmin([throttled]), QUERY, {}, { sleep }),
      ),
    ).rejects.toBe(lost);
    expect(stderr.mock.calls.join("")).not.toContain("shopify_graphql_failed");
  });
});
