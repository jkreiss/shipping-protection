import { describe, expect, test, vi } from "vitest";
import {
  purgeExpiredDeliveryBatch, purgeExpiredOrders, purgeExpiredShopBatch, RETENTION_TRANSACTION_OPTIONS, shopsWithExpiredOrders,
} from "./order-retention.server.js";

// shops: ids that still hold expired orders. batches: per shop, what successive
// order lookups find. deliveries: what successive delivery lookups find.
function retentionDatabase({ shops = [], batches = {}, deliveries = [] } = {}) {
  const queues = new Map(Object.entries(batches).map(([shopId, list]) => [shopId, [...list]]));
  const deliveryQueue = [...deliveries];
  const deleted = () => vi.fn().mockResolvedValue({ count: 1 });
  const database = {
    shop: { findMany: vi.fn().mockResolvedValue(shops.map((id) => ({ id }))) },
    order: {
      findMany: vi.fn(async ({ where }) => queues.get(where.shopId)?.shift() ?? []),
      deleteMany: vi.fn(async ({ where }) => ({ count: where.id.in.length })),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    claimEvent: { deleteMany: deleted() },
    claim: { deleteMany: deleted() },
    protectionRefund: { deleteMany: deleted() },
    protectionPurchase: { deleteMany: deleted() },
    orderLine: { deleteMany: deleted() },
    webhookDelivery: {
      findMany: vi.fn(async () => deliveryQueue.shift() ?? []),
      deleteMany: vi.fn(async ({ where }) => ({ count: where.id?.in.length ?? 0 })),
    },
  };
  database.$transaction = vi.fn((run) => run(database));
  return database;
}

const order = (id) => ({ id, shopifyOrderId: `gid://shopify/Order/${id}` });
const cutoff = new Date("2024-10-07T00:00:00.000Z");
const now = new Date("2026-10-07T00:00:00.000Z");
const oldestFirst = [{ shopifyCreatedAt: "asc" }, { id: "asc" }];

describe("one shop's purge batch", () => {
  test("deletes that shop's oldest expired orders with everything recorded against them", async () => {
    const db = retentionDatabase({ batches: { "shop-a": [[order("1"), order("3")]] } });

    expect(await purgeExpiredShopBatch(db, "shop-a", cutoff, 10)).toEqual({ selected: 2, deleted: 2 });

    expect(db.order.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-a", shopifyCreatedAt: { lt: cutoff } }, orderBy: oldestFirst, take: 10,
      select: { id: true, shopifyOrderId: true },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL app.allow_shop_redaction = 'on'");
    expect(db.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-a", id: { in: ["1", "3"] } } });
    expect(db.protectionPurchase.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-a", orderId: { in: ["1", "3"] } } });
    expect(db.claimEvent.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-a", claim: { protectionPurchase: { orderId: { in: ["1", "3"] } } } },
    });
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-a", shopifyOrderId: { in: ["gid://shopify/Order/1", "gid://shopify/Order/3"] } },
    });
  });

  test("counts orders actually deleted when a redaction got there first", async () => {
    const db = retentionDatabase({ batches: { "shop-a": [[order("1"), order("2")]] } });
    db.order.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await purgeExpiredShopBatch(db, "shop-a", cutoff, 10)).toEqual({ selected: 2, deleted: 1 });
  });

  test("deletes nothing when the shop has no expired order", async () => {
    const db = retentionDatabase();
    expect(await purgeExpiredShopBatch(db, "shop-a", cutoff, 10)).toEqual({ selected: 0, deleted: 0 });
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("shops with expired orders", () => {
  test("lists only shops holding an expired order, leaving out skipped shops", async () => {
    const db = retentionDatabase({ shops: ["shop-a", "shop-b"] });
    expect(await shopsWithExpiredOrders(db, cutoff, ["shop-z"])).toEqual(["shop-a", "shop-b"]);
    expect(db.shop.findMany).toHaveBeenCalledWith({
      where: { id: { notIn: ["shop-z"] }, orders: { some: { shopifyCreatedAt: { lt: cutoff } } } },
      orderBy: { id: "asc" }, select: { id: true },
    });
  });
});

describe("expired delivery batch", () => {
  test("deletes finished deliveries received before the cutoff, by id", async () => {
    const db = retentionDatabase({ deliveries: [[{ id: "d1" }, { id: "d2" }]] });
    expect(await purgeExpiredDeliveryBatch(db, cutoff, 10)).toEqual({ selected: 2, deleted: 2 });
    const finished = { in: ["PROCESSED", "FAILED"] };
    expect(db.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: cutoff }, status: finished }, select: { id: true }, take: 10,
    });
    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["d1", "d2"] }, status: finished } });
  });

  test("issues no delete when nothing has expired", async () => {
    const db = retentionDatabase();
    expect(await purgeExpiredDeliveryBatch(db, cutoff, 10)).toEqual({ selected: 0, deleted: 0 });
    expect(db.webhookDelivery.deleteMany).not.toHaveBeenCalled();
  });
});

describe("order retention purge", () => {
  test("works through each shop in bounded transactions, then sweeps old deliveries in batches", async () => {
    const db = retentionDatabase({
      shops: ["shop-a", "shop-b"],
      batches: { "shop-a": [[order("1"), order("2")], [order("3")]], "shop-b": [[order("4")]] },
      deliveries: [[{ id: "d1" }, { id: "d2" }], [{ id: "d3" }]],
    });
    const onProgress = vi.fn();

    const result = await purgeExpiredOrders({ database: db, now, batchSize: 2, onProgress });

    expect(result).toEqual({ cutoff, ordersDeleted: 4, deliveriesDeleted: 3, failedShopIds: [], complete: true });
    // A short batch means the shop is done, so shop-a needs no third lookup.
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    for (const call of db.$transaction.mock.calls) expect(call[1]).toEqual(RETENTION_TRANSACTION_OPTIONS);
    expect(db.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-b", id: { in: ["4"] } } });
    expect(db.webhookDelivery.findMany).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(5);
  });

  test("keeps purging other shops when one shop fails", async () => {
    const db = retentionDatabase({ shops: ["shop-a", "shop-b"], batches: { "shop-b": [[order("4")]] } });
    const failure = Object.assign(new Error("Transaction already closed"), { code: "P2028" });
    const findMany = db.order.findMany.getMockImplementation();
    db.order.findMany.mockImplementation(async (args) => {
      if (args.where.shopId === "shop-a") throw failure;
      return findMany(args);
    });
    const onShopFailure = vi.fn();

    const result = await purgeExpiredOrders({ database: db, now, onShopFailure });

    expect(result).toMatchObject({ ordersDeleted: 1, failedShopIds: ["shop-a"], complete: true });
    expect(onShopFailure).toHaveBeenCalledWith("shop-a", failure);
    expect(db.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-b", id: { in: ["4"] } } });
  });

  test("passes skipped shops to the shop lookup", async () => {
    const db = retentionDatabase();
    await purgeExpiredOrders({ database: db, now, skipShopIds: ["shop-a"] });
    expect(db.shop.findMany.mock.calls[0][0].where.id).toEqual({ notIn: ["shop-a"] });
  });

  test("pauses when its time budget runs out, leaving deliveries for the finished run", async () => {
    const db = retentionDatabase({ shops: ["s"], batches: { s: [[order("1")], [order("2")]] } });
    let clock = 0;
    db.$transaction.mockImplementation(async (run) => { clock += 600; return run(db); });

    const result = await purgeExpiredOrders({ database: db, batchSize: 1, budgetMs: 1_000, clock: () => clock });

    expect(result).toMatchObject({ ordersDeleted: 2, deliveriesDeleted: 0, complete: false });
    expect(db.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  test("pauses partway through the delivery sweep", async () => {
    const db = retentionDatabase({ deliveries: [[{ id: "d1" }], [{ id: "d2" }]] });
    let clock = 0;
    db.webhookDelivery.deleteMany.mockImplementation(async ({ where }) => { clock += 600; return { count: where.id.in.length }; });

    const result = await purgeExpiredOrders({ database: db, batchSize: 1, budgetMs: 1_000, clock: () => clock });

    expect(result).toMatchObject({ deliveriesDeleted: 2, complete: false });
  });

  test("stops between batches when the worker stops", async () => {
    const db = retentionDatabase({ shops: ["s"], batches: { s: [[order("1")], [order("2")]] } });
    let stopping = false;
    const result = await purgeExpiredOrders({
      database: db, batchSize: 1, shouldStop: () => stopping, onProgress: () => { stopping = true; },
    });

    expect(result).toMatchObject({ ordersDeleted: 1, complete: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
