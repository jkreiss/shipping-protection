// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { withShopSettingsLock } from "./shop.server.js";
import { withInstalledShopWrite } from "./settings-lease-context.server.js";
import { adminGraphql } from "./shopify/admin-graphql.server.js";
const query = `#graphql
 query LeaseShop { shop { id } }`;
afterEach(() => vi.useRealTimers());
function fixture() {
  const rows = new Map(
    ["one", "two"].map((name) => [
      `${name}.myshopify.com`,
      {
        id: name,
        shopDomain: `${name}.myshopify.com`,
        installationState: "INSTALLED",
        installationGeneration: 0,
        settingsLockedUntil: null,
        settingsLockToken: null,
      },
    ]),
  );
  const database = {
    shop: {
      findUnique: async ({ where }) => ({ ...rows.get(where.shopDomain) }),
      updateMany: async ({ where, data }) => {
        const row =
          rows.get(where.shopDomain) ??
          [...rows.values()].find((r) => r.id === where.id);
        if (
          !row ||
          (where.installationState &&
            row.installationState !== where.installationState) ||
          (where.installationGeneration !== undefined &&
            row.installationGeneration !== where.installationGeneration) ||
          (where.settingsLockToken &&
            row.settingsLockToken !== where.settingsLockToken) ||
          (where.settingsLockedUntil?.gt &&
            !(row.settingsLockedUntil > where.settingsLockedUntil.gt)) ||
          (where.OR &&
            row.settingsLockedUntil > where.OR[1].settingsLockedUntil.lte)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  database.$transaction = async (run) => run(database);
  return { database, rows };
}

test("separate tenant leases proceed independently and nested API receives cancellation", async () => {
  const f = fixture();
  await withShopSettingsLock(
    "one.myshopify.com",
    async ({ signal }) => {
      await withShopSettingsLock("two.myshopify.com", async () => "two", {
        database: f.database,
      });
      const admin = {
        graphql: vi.fn(async (_query, options) => {
          expect(options.signal).toBe(signal);
          return { json: async () => ({ data: {} }) };
        }),
      };
      await adminGraphql(admin, query);
      await expect(
        adminGraphql(admin, query, {}, { shop: "two.myshopify.com" }),
      ).rejects.toThrow("tenant mismatch");
    },
    { database: f.database },
  );
});

test("uninstall stops nested API and local commits", async () => {
  const f = fixture();
  const write = vi.fn(async () => "saved");
  const admin = { graphql: vi.fn() };
  await expect(
    withShopSettingsLock(
      "one.myshopify.com",
      async () => {
        f.rows.get("one.myshopify.com").installationState = "UNINSTALLED";
        await expect(adminGraphql(admin, query)).rejects.toThrow(/interrupted/);
        await withInstalledShopWrite(f.database, "one.myshopify.com", write);
      },
      { database: f.database },
    ),
  ).rejects.toThrow(/interrupted/);
  expect(write).not.toHaveBeenCalled();
  expect(admin.graphql).not.toHaveBeenCalled();
});

test("ownership is checked again after a pacing wait", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const admin = {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: {},
        extensions: {
          cost: {
            requestedQueryCost: 100,
            throttleStatus: { currentlyAvailable: 0, restoreRate: 50 },
          },
        },
      }),
    })),
  };
  await expect(
    withShopSettingsLock(
      "one.myshopify.com",
      async () => {
        await adminGraphql(admin, query);
        await adminGraphql(
          admin,
          query,
          {},
          {
            sleep: async (ms) => {
              vi.setSystemTime(Date.now() + ms);
              f.rows.get("one.myshopify.com").settingsLockToken = "successor";
            },
          },
        );
      },
      { database: f.database },
    ),
  ).rejects.toThrow(/interrupted/);
  expect(admin.graphql).toHaveBeenCalledTimes(1);
});

test("a crashed or expired owner cannot continue or renew", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    withShopSettingsLock(
      "one.myshopify.com",
      async ({ assertHeld, signal }) => {
        // Moving wall-clock time without running timers simulates a stalled process.
        vi.setSystemTime(Date.now() + 6 * 60_000);
        await expect(assertHeld()).rejects.toThrow(/interrupted/);
        expect(signal.aborted).toBe(true);
      },
      { database: f.database },
    ),
  ).rejects.toThrow(/interrupted/);
});

test("a retryable transaction conflict preserves the lease and retries local commits", async () => {
  const f = fixture();
  let attempts = 0;
  f.database.$transaction = async (run) => {
    attempts += 1;
    const tx = {
      shop: {
        ...f.database.shop,
        updateMany: async (args) => {
          if (attempts === 1 && args.where.settingsLockToken)
            throw Object.assign(new Error("conflict"), { code: "P2034" });
          return f.database.shop.updateMany(args);
        },
      },
    };
    return run(tx);
  };
  const write = vi.fn(async () => "saved");
  await expect(
    withShopSettingsLock(
      "one.myshopify.com",
      async ({ signal }) => {
        const result = await withInstalledShopWrite(
          f.database,
          "one.myshopify.com",
          write,
        );
        expect(signal.aborted).toBe(false);
        return result;
      },
      { database: f.database },
    ),
  ).resolves.toBe("saved");
  expect(attempts).toBe(2);
  expect(write).toHaveBeenCalledTimes(1);
});

test("a pending ownership check cannot permit writes after renewal fails", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const original = f.database.shop.updateMany;
  let finishCheck,
    checking,
    checked = false;
  const pending = new Promise((resolve) => {
    checking = resolve;
  });
  f.database.shop.updateMany = async (args) => {
    if (args.data.settingsLockedUntil && !args.data.settingsLockToken)
      throw new Error("renewal offline");
    if (
      args.data.settingsLockToken &&
      !args.data.settingsLockedUntil &&
      !checked
    ) {
      checked = true;
      checking();
      return new Promise((resolve) => {
        finishCheck = resolve;
      });
    }
    return original(args);
  };
  const write = vi.fn(async () => "saved");
  const action = withShopSettingsLock(
    "one.myshopify.com",
    async () => withInstalledShopWrite(f.database, "one.myshopify.com", write),
    { database: f.database },
  );
  const outcome = action.catch((error) => error);
  await pending;
  await vi.advanceTimersByTimeAsync(60_000);
  finishCheck({ count: 1 });
  expect(await outcome).toBeInstanceOf(Error);
  expect(write).not.toHaveBeenCalled();
});
