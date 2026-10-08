import { describe, expect, test, vi } from "vitest";
import { recordGrantedScopes, redactCustomerOrders, withShopSettingsLock } from "./shop.server";
import { UserFacingError } from "./user-facing-error";

function database() {
  return { session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
}

describe("granted scopes", () => {
  test("stores the current scopes on the shop's own session", async () => {
    const db = database();
    const recorded = await recordGrantedScopes({
      shopDomain: "one.myshopify.com", sessionId: "offline_one.myshopify.com",
      scopes: ["write_products", "read_orders"], database: db,
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
      shopDomain: "one.myshopify.com", sessionId: "offline_one.myshopify.com", scopes, database: db,
    });
    expect(recorded).toBe(false);
    expect(db.session.updateMany).not.toHaveBeenCalled();
  });
});

describe("settings lock", () => {
  function lockDatabase() {
    const row = { shopDomain: "one.myshopify.com", settingsLockedUntil: null };
    const matches = (where) => where.shopDomain === row.shopDomain && (where.OR
      ? where.OR.some((clause) => clause.settingsLockedUntil === null
        ? row.settingsLockedUntil === null
        : row.settingsLockedUntil !== null && row.settingsLockedUntil <= clause.settingsLockedUntil.lte)
      : row.settingsLockedUntil?.getTime() === where.settingsLockedUntil.getTime());
    return {
      row,
      shop: { updateMany: vi.fn(async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }) },
    };
  }

  test("runs one change at a time per shop and releases afterwards", async () => {
    const db = lockDatabase();
    let release;
    const first = withShopSettingsLock("one.myshopify.com",
      () => new Promise((resolve) => { release = resolve; }), { database: db });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    await expect(withShopSettingsLock("one.myshopify.com", async () => "second", { database: db }))
      .rejects.toThrow(UserFacingError);
    release("first");
    expect(await first).toBe("first");
    expect(db.row.settingsLockedUntil).toBeNull();
    expect(await withShopSettingsLock("one.myshopify.com", async () => "third", { database: db })).toBe("third");
  });

  test("releases the lock when the change fails", async () => {
    const db = lockDatabase();
    await expect(withShopSettingsLock("one.myshopify.com", async () => { throw new Error("shopify down"); }, { database: db }))
      .rejects.toThrow("shopify down");
    expect(db.row.settingsLockedUntil).toBeNull();
  });

  test("takes over a lock left behind by a crashed change", async () => {
    const db = lockDatabase();
    db.row.settingsLockedUntil = new Date(Date.now() - 1000);
    expect(await withShopSettingsLock("one.myshopify.com", async () => "ok", { database: db })).toBe("ok");
  });

  test("refuses to run without a shop domain", async () => {
    const db = lockDatabase();
    await expect(withShopSettingsLock(undefined, async () => "x", { database: db })).rejects.toThrow("shop domain");
    expect(db.shop.updateMany).not.toHaveBeenCalled();
  });
});

describe("customer redaction", () => {
  function redactionDatabase() {
    const deleted = () => vi.fn().mockResolvedValue({ count: 1 });
    return {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1" }) },
      order: { findMany: vi.fn().mockResolvedValue([{ id: "order-1" }, { id: "order-2" }]), deleteMany: deleted() },
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
    const redacted = await redactCustomerOrders(db, "one.myshopify.com", [1001, "1002"]);

    expect(redacted).toBe(2);
    const gids = ["gid://shopify/Order/1001", "gid://shopify/Order/1002"];
    expect(db.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: "one.myshopify.com" }, select: { id: true } });
    expect(db.order.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyOrderId: { in: gids } }, select: { id: true },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL app.allow_shop_redaction = 'on'");
    const orders = { in: ["order-1", "order-2"] };
    expect(db.claimEvent.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", claim: { protectionPurchase: { orderId: orders } } },
    });
    expect(db.claim.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-1", protectionPurchase: { orderId: orders } } });
    for (const table of [db.protectionRefund, db.protectionPurchase, db.orderLine]) {
      expect(table.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-1", orderId: orders } });
    }
    expect(db.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-1", id: orders } });
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyOrderId: { in: gids } },
    });
  });

  test("removes queued deliveries for named orders that are not stored yet", async () => {
    const db = redactionDatabase();
    db.order.findMany.mockResolvedValue([]);
    expect(await redactCustomerOrders(db, "one.myshopify.com", [1001])).toBe(0);
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyOrderId: { in: ["gid://shopify/Order/1001"] } },
    });
    expect(db.order.deleteMany).not.toHaveBeenCalled();
  });

  test("does nothing for an unknown shop", async () => {
    const db = redactionDatabase();
    db.shop.findUnique.mockResolvedValue(null);
    expect(await redactCustomerOrders(db, "gone.myshopify.com", [1001])).toBe(0);
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
    expect(await redactCustomerOrders(db, "one.myshopify.com", orderIds)).toBe(0);
    expect(db.shop.findUnique).not.toHaveBeenCalled();
  });
});
