import { describe, expect, test, vi } from "vitest";
import { markShopUninstalled, recordGrantedScopes, redactShopData, withShopSettingsLock } from "./shop.server";
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

describe("uninstalling", () => {
  test("ends the shop's open billing terms, since Shopify cancels the subscription", async () => {
    const calls = [];
    const transaction = {
      session: { deleteMany: vi.fn(async (args) => calls.push(["session", args])) },
      shop: { updateMany: vi.fn(async (args) => calls.push(["shop", args])) },
      billingAgreement: { updateMany: vi.fn(async (args) => calls.push(["billingAgreement", args])) },
    };
    const db = { $transaction: async (run) => run(transaction) };

    await markShopUninstalled("one.myshopify.com", { database: db });

    expect(transaction.billingAgreement.updateMany).toHaveBeenCalledWith({
      where: { shop: { shopDomain: "one.myshopify.com" }, status: { in: ["PENDING_APPROVAL", "ACTIVE"] } },
      data: { status: "CANCELLED", endedAt: expect.any(Date) },
    });
    expect(transaction.shop.updateMany).toHaveBeenCalled();
  });
});

describe("shop redaction", () => {
  test("deletes the shop's billing ledger, charges and agreements before the shop", async () => {
    const order = [];
    const table = (name) => ({ deleteMany: vi.fn(async (args) => { order.push([name, args]); return { count: 0 }; }) });
    const transaction = {
      $executeRawUnsafe: vi.fn(),
      shop: { findUnique: vi.fn(async () => ({ id: "shop-1" })), update: vi.fn(), deleteMany: table("shop").deleteMany },
      ...Object.fromEntries(["claimEvent", "claim", "protectionRefund", "protectionPurchase", "orderLine", "order",
        "pricingRule", "session", "billingEntry", "billingCharge", "billingAgreement"].map((name) => [name, table(name)])),
    };

    await redactShopData(transaction, "one.myshopify.com");

    const names = order.map(([name]) => name);
    expect(names.indexOf("billingEntry")).toBeLessThan(names.indexOf("billingCharge"));
    expect(names.indexOf("billingCharge")).toBeLessThan(names.indexOf("billingAgreement"));
    expect(names.indexOf("billingAgreement")).toBeLessThan(names.indexOf("shop"));
    for (const name of ["billingEntry", "billingCharge", "billingAgreement"]) {
      expect(order.find(([table]) => table === name)[1]).toEqual({ where: { shopId: "shop-1" } });
    }
  });
});
