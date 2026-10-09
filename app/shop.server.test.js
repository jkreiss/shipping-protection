import { afterEach, describe, expect, test, vi } from "vitest";
import {
  InstallationAccessLostError,
  deleteShopData,
  ensureInstalledShop,
  recordGrantedScopes,
  redactCustomerOrders,
  withShopSettingsLock,
} from "./shop.server";
import { UserFacingError } from "./user-facing-error";

afterEach(() => vi.useRealTimers());

function database() {
  return { session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
}

describe("granted scopes", () => {
  test("stores the current scopes on the shop's own session", async () => {
    const db = database();
    const recorded = await recordGrantedScopes({
      shopDomain: "one.myshopify.com",
      sessionId: "offline_one.myshopify.com",
      scopes: ["write_products", "read_orders"],
      database: db,
    });
    expect(recorded).toBe(true);
    expect(db.session.updateMany).toHaveBeenCalledWith({
      where: { id: "offline_one.myshopify.com", shop: "one.myshopify.com" },
      data: { scope: "write_products,read_orders" },
    });
  });

  test.each([
    ["missing", undefined],
    ["not a list", "write_products"],
    ["not scope names", [{ handle: "write_products" }]],
  ])("ignores a payload whose scopes are %s", async (_name, scopes) => {
    const db = database();
    const recorded = await recordGrantedScopes({
      shopDomain: "one.myshopify.com",
      sessionId: "offline_one.myshopify.com",
      scopes,
      database: db,
    });
    expect(recorded).toBe(false);
    expect(db.session.updateMany).not.toHaveBeenCalled();
  });
});

describe("settings lock", () => {
  function lockDatabase() {
    const row = {
      shopDomain: "one.myshopify.com",
      installationState: "INSTALLED",
      settingsLockToken: null,
      settingsLockedUntil: null,
    };
    const matches = (where) =>
      where.shopDomain === row.shopDomain &&
      (!where.installationState ||
        where.installationState === row.installationState) &&
      (!where.settingsLockToken ||
        where.settingsLockToken === row.settingsLockToken) &&
      (!where.settingsLockedUntil?.gt ||
        row.settingsLockedUntil > where.settingsLockedUntil.gt) &&
      (!where.OR ||
        where.OR.some((clause) =>
          clause.settingsLockedUntil === null
            ? row.settingsLockedUntil === null
            : row.settingsLockedUntil !== null &&
              row.settingsLockedUntil <= clause.settingsLockedUntil.lte,
        ));
    return {
      row,
      shop: {
        updateMany: vi.fn(async ({ where, data }) => {
          if (!matches(where)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
  }

  test("runs one change at a time per shop and releases afterwards", async () => {
    const db = lockDatabase();
    let release;
    const first = withShopSettingsLock(
      "one.myshopify.com",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { database: db },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    await expect(
      withShopSettingsLock("one.myshopify.com", async () => "second", {
        database: db,
      }),
    ).rejects.toThrow(UserFacingError);
    release("first");
    expect(await first).toBe("first");
    expect(db.row.settingsLockedUntil).toBeNull();
    expect(
      await withShopSettingsLock("one.myshopify.com", async () => "third", {
        database: db,
      }),
    ).toBe("third");
  });

  test("releases the lock when the change fails", async () => {
    const db = lockDatabase();
    await expect(
      withShopSettingsLock(
        "one.myshopify.com",
        async () => {
          throw new Error("shopify down");
        },
        { database: db },
      ),
    ).rejects.toThrow("shopify down");
    expect(db.row.settingsLockedUntil).toBeNull();
  });

  test("takes over a lock left behind by a crashed change", async () => {
    const db = lockDatabase();
    db.row.settingsLockedUntil = new Date(Date.now() - 1000);
    expect(
      await withShopSettingsLock("one.myshopify.com", async () => "ok", {
        database: db,
      }),
    ).toBe("ok");
  });

  test("renews beyond five minutes and keeps exclusivity", async () => {
    vi.useFakeTimers();
    const db = lockDatabase();
    let finish;
    const first = withShopSettingsLock(
      "one.myshopify.com",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { database: db },
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await expect(
      withShopSettingsLock("one.myshopify.com", async () => "overlap", {
        database: db,
      }),
    ).rejects.toThrow(UserFacingError);
    finish("ok");
    expect(await first).toBe("ok");
  });

  test.each([false, true])(
    "release failure preserves the action outcome (failed=%s)",
    async (failed) => {
      const db = lockDatabase();
      db.shop.updateMany.mockImplementationOnce(async ({ data }) => {
        Object.assign(db.row, data);
        return { count: 1 };
      });
      const failure = new Error("action failed");
      const run = async () => {
        const original = db.shop.updateMany.getMockImplementation();
        db.shop.updateMany.mockImplementation(async (args) => {
          if (args.data.settingsLockToken === null)
            throw new Error("cleanup failed");
          return original(args);
        });
        if (failed) throw failure;
        return "saved";
      };
      if (failed)
        await expect(
          withShopSettingsLock("one.myshopify.com", run, { database: db }),
        ).rejects.toBe(failure);
      else
        await expect(
          withShopSettingsLock("one.myshopify.com", run, { database: db }),
        ).resolves.toBe("saved");
    },
  );

  test("an expired owner cannot renew or release a successor lease", async () => {
    vi.useFakeTimers();
    const db = lockDatabase();
    let finish, lease;
    const first = withShopSettingsLock(
      "one.myshopify.com",
      (held) => {
        lease = held;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { database: db },
    );
    // Observe the rejection immediately to avoid an unhandled rejection in fake time.
    const outcome = first.catch((error) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    db.row.settingsLockToken = "successor";
    db.row.settingsLockedUntil = new Date(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertHeld()).rejects.toThrow(/interrupted/);
    finish("old");
    expect(await outcome).toBeInstanceOf(UserFacingError);
    expect(db.row.settingsLockToken).toBe("successor");
  });

  test("renewal failure aborts subsequent writes", async () => {
    vi.useFakeTimers();
    const db = lockDatabase();
    let finish, lease;
    const first = withShopSettingsLock(
      "one.myshopify.com",
      (held) => {
        lease = held;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { database: db },
    );
    const outcome = first.catch((error) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    db.shop.updateMany.mockRejectedValueOnce(new Error("database offline"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertHeld()).rejects.toThrow(/interrupted/);
    finish("old");
    expect(await outcome).toBeInstanceOf(UserFacingError);
  });

  test("refuses to run without a shop domain", async () => {
    const db = lockDatabase();
    await expect(
      withShopSettingsLock(undefined, async () => "x", { database: db }),
    ).rejects.toThrow("shop domain");
    expect(db.shop.updateMany).not.toHaveBeenCalled();
  });
});

describe("customer redaction", () => {
  function redactionDatabase() {
    const deleted = () => vi.fn().mockResolvedValue({ count: 1 });
    return {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1" }) },
      order: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "order-1" }, { id: "order-2" }]),
        deleteMany: deleted(),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      claimEvent: { deleteMany: deleted() },
      claim: { deleteMany: deleted() },
      protectionRefund: { deleteMany: deleted() },
      protectionPurchase: { deleteMany: deleted() },
      orderLine: { deleteMany: deleted() },
      webhookDelivery: { deleteMany: deleted() },
    };
  }

  test("deletes the named orders and everything recorded against them in that shop", async () => {
    const db = redactionDatabase();
    const redacted = await redactCustomerOrders(db, "one.myshopify.com", [
      1001,
      "1002",
    ]);

    expect(redacted).toBe(2);
    const gids = ["gid://shopify/Order/1001", "gid://shopify/Order/1002"];
    expect(db.shop.findUnique).toHaveBeenCalledWith({
      where: { shopDomain: "one.myshopify.com" },
      select: { id: true },
    });
    expect(db.order.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyOrderId: { in: gids } },
      select: { id: true },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET LOCAL app.allow_shop_redaction = 'on'",
    );
    const orders = { in: ["order-1", "order-2"] };
    expect(db.claimEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        claim: { protectionPurchase: { orderId: orders } },
      },
    });
    expect(db.claim.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", protectionPurchase: { orderId: orders } },
    });
    for (const table of [
      db.protectionRefund,
      db.protectionPurchase,
      db.orderLine,
    ]) {
      expect(table.deleteMany).toHaveBeenCalledWith({
        where: { shopId: "shop-1", orderId: orders },
      });
    }
    expect(db.order.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", id: orders },
    });
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyOrderId: { in: gids } },
    });
  });

  test("removes queued deliveries for named orders that are not stored yet", async () => {
    const db = redactionDatabase();
    db.order.findMany.mockResolvedValue([]);
    expect(await redactCustomerOrders(db, "one.myshopify.com", [1001])).toBe(0);
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        shopifyOrderId: { in: ["gid://shopify/Order/1001"] },
      },
    });
    expect(db.order.deleteMany).not.toHaveBeenCalled();
  });

  test("does nothing for an unknown shop", async () => {
    const db = redactionDatabase();
    db.shop.findUnique.mockResolvedValue(null);
    expect(await redactCustomerOrders(db, "gone.myshopify.com", [1001])).toBe(
      0,
    );
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", undefined],
    ["empty", []],
    ["not a list", "1001"],
    ["not order IDs", [1001, "gid://shopify/Order/1002"]],
    ["fractional", [10.5]],
  ])("ignores a payload whose order list is %s", async (_name, orderIds) => {
    const db = redactionDatabase();
    expect(await redactCustomerOrders(db, "one.myshopify.com", orderIds)).toBe(
      0,
    );
    expect(db.shop.findUnique).not.toHaveBeenCalled();
  });
});


test("a pre-reinstall read cannot update the current Shopify identity", async () => {
  const transaction = vi.fn();
  await expect(ensureInstalledShop("one.myshopify.com", "gid://shopify/Shop/2", {
    shop: { findUnique: async () => ({ id: "shop-1", installationState: "INSTALLED", installationGeneration: 2, shopGid: "gid://shopify/Shop/1" }) },
    $transaction: transaction,
  }, 0)).rejects.toThrow(/access|installation/i);
  expect(transaction).not.toHaveBeenCalled();
});

describe("Shopify identity update", () => {
  const installed = { id: "shop-1", installationState: "INSTALLED", installationGeneration: 2, shopGid: "gid://shopify/Shop/1" };
  const identityDatabase = (count) => {
    const transaction = { shop: { updateMany: vi.fn().mockResolvedValue({ count }) } };
    return {
      transaction,
      shop: { findUnique: async () => installed },
      $transaction: async (run) => run(transaction),
    };
  };

  test("an uninstall racing the update is lost access, not a server error", async () => {
    const db = identityDatabase(0);
    await expect(
      ensureInstalledShop("one.myshopify.com", "gid://shopify/Shop/2", db),
    ).rejects.toBeInstanceOf(InstallationAccessLostError);
    expect(db.transaction.shop.updateMany).toHaveBeenCalledWith({
      where: { id: "shop-1", installationState: "INSTALLED", installationGeneration: 2 },
      data: { shopGid: "gid://shopify/Shop/2" },
    });
  });

  test("returns the shop with the new Shopify identity", async () => {
    const db = identityDatabase(1);
    expect(
      await ensureInstalledShop("one.myshopify.com", "gid://shopify/Shop/2", db),
    ).toEqual({ ...installed, shopGid: "gid://shopify/Shop/2" });
  });
});

describe("shop redaction", () => {
  function shopDatabase(seen, locked = seen) {
    const deleted = () => vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue(locked ? [locked] : []),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      shop: {
        findUnique: vi.fn().mockResolvedValue(locked && { id: "shop-1" }),
        update: vi.fn().mockResolvedValue({}),
        deleteMany: deleted(),
      },
      claimEvent: { deleteMany: deleted() },
      claim: { deleteMany: deleted() },
      protectionRefund: { deleteMany: deleted() },
      protectionPurchase: { deleteMany: deleted() },
      orderLine: { deleteMany: deleted() },
      order: { deleteMany: deleted() },
      pricingRule: { deleteMany: deleted() },
      session: { deleteMany: deleted() },
    };
    const db = {
      shop: { findUnique: vi.fn().mockResolvedValue(seen) },
      $transaction: (run) => run(tx),
    };
    return { tx, db };
  }
  const installed = { installationState: "INSTALLED", installationGeneration: 2 };
  const uninstalled = { installationState: "UNINSTALLED", installationGeneration: 3 };

  test("keeps the data of a shop Shopify says is installed", async () => {
    const { tx, db } = shopDatabase(installed);
    const isInstalled = vi.fn().mockResolvedValue(true);
    expect(await deleteShopData("one.myshopify.com", { isInstalled, database: db })).toBe(false);
    expect(isInstalled).toHaveBeenCalledWith("one.myshopify.com");
    expect(tx.shop.deleteMany).not.toHaveBeenCalled();
    expect(tx.order.deleteMany).not.toHaveBeenCalled();
  });

  test("deletes a shop marked installed whose uninstall was lost", async () => {
    const { tx, db } = shopDatabase(installed);
    const isInstalled = vi.fn().mockResolvedValue(false);
    expect(await deleteShopData("one.myshopify.com", { isInstalled, database: db })).toBe(true);
    expect(tx.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-1" } });
  });

  test("deletes an uninstalled shop without asking Shopify", async () => {
    const { tx, db } = shopDatabase(uninstalled);
    const isInstalled = vi.fn();
    expect(await deleteShopData("one.myshopify.com", { isInstalled, database: db })).toBe(true);
    expect(isInstalled).not.toHaveBeenCalled();
    expect(tx.shop.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: "one.myshopify.com" },
    });
  });

  test("keeps the data when a reinstall finishes during the check", async () => {
    const { tx, db } = shopDatabase(uninstalled, { installationState: "INSTALLED", installationGeneration: 4 });
    expect(await deleteShopData("one.myshopify.com", { isInstalled: vi.fn(), database: db })).toBe(false);
    expect(tx.shop.deleteMany).not.toHaveBeenCalled();
  });

  test("still deletes when an uninstall lands during the check", async () => {
    const { tx, db } = shopDatabase(installed, uninstalled);
    const isInstalled = vi.fn().mockResolvedValue(false);
    expect(await deleteShopData("one.myshopify.com", { isInstalled, database: db })).toBe(true);
    expect(tx.shop.deleteMany).toHaveBeenCalled();
  });

  test("propagates an inconclusive check so Shopify retries", async () => {
    const { tx, db } = shopDatabase(installed);
    const isInstalled = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(deleteShopData("one.myshopify.com", { isInstalled, database: db })).rejects.toThrow("timeout");
    expect(tx.shop.deleteMany).not.toHaveBeenCalled();
  });

  test("a shop that is not stored is a no-op", async () => {
    const { tx, db } = shopDatabase(null);
    await expect(deleteShopData("gone.myshopify.com", { isInstalled: vi.fn(), database: db })).resolves.toBe(false);
    expect(tx.shop.deleteMany).not.toHaveBeenCalled();
  });
});
