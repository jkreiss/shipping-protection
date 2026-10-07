import { describe, expect, test, vi } from "vitest";
import { purgeExpiredOrderBatch, purgeExpiredOrders } from "./order-retention.server.js";

// Each batch is the oldest expired order's shop, then up to batchSize of that
// shop's expired orders. batches lists what successive batches find.
function retentionDatabase(batches) {
  const deleted = () => vi.fn().mockResolvedValue({ count: 1 });
  const findFirst = vi.fn();
  const findMany = vi.fn();
  for (const { shopId, orders } of batches) {
    findFirst.mockResolvedValueOnce({ shopId });
    findMany.mockResolvedValueOnce(orders);
  }
  findFirst.mockResolvedValue(null);
  const database = {
    order: { findFirst, findMany, deleteMany: deleted() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    claimEvent: { deleteMany: deleted() },
    claim: { deleteMany: deleted() },
    protectionRefund: { deleteMany: deleted() },
    protectionPurchase: { deleteMany: deleted() },
    orderLine: { deleteMany: deleted() },
    webhookDelivery: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  database.$transaction = vi.fn((run) => run(database));
  return database;
}

const order = (id) => ({ id, shopifyOrderId: `gid://shopify/Order/${id}` });

describe("order retention purge", () => {
  test("deletes one shop's expired orders per batch, with everything recorded against them", async () => {
    const db = retentionDatabase([{ shopId: "shop-a", orders: [order("1"), order("3")] }]);
    const cutoff = new Date("2024-10-07T00:00:00.000Z");

    expect(await purgeExpiredOrderBatch(db, cutoff, 10)).toBe(2);

    const oldestFirst = [{ shopifyCreatedAt: "asc" }, { id: "asc" }];
    expect(db.order.findFirst).toHaveBeenCalledWith({
      where: { shopifyCreatedAt: { lt: cutoff } }, orderBy: oldestFirst, select: { shopId: true },
    });
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

  test("deletes nothing when no order has expired", async () => {
    const db = retentionDatabase([]);
    expect(await purgeExpiredOrderBatch(db, new Date(), 10)).toBe(0);
    expect(db.order.findMany).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test("works through every shop one transaction per batch, then removes finished old deliveries", async () => {
    const db = retentionDatabase([
      { shopId: "shop-a", orders: [order("1"), order("2")] },
      { shopId: "shop-b", orders: [order("3")] },
    ]);
    db.webhookDelivery.deleteMany.mockImplementation(async ({ where }) => ({ count: where.receivedAt ? 7 : 1 }));
    const onProgress = vi.fn();

    const result = await purgeExpiredOrders({ database: db, now: new Date("2026-10-07T00:00:00.000Z"), onProgress });

    expect(result).toEqual({
      cutoff: new Date("2024-10-07T00:00:00.000Z"), ordersDeleted: 3, deliveriesDeleted: 7, complete: true,
    });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(db.order.deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop-b", id: { in: ["3"] } } });
    expect(db.webhookDelivery.deleteMany).toHaveBeenLastCalledWith({
      where: { receivedAt: { lt: result.cutoff }, status: { in: ["PROCESSED", "FAILED"] } },
    });
  });

  test("pauses when its time budget runs out, leaving deliveries for the finished run", async () => {
    const db = retentionDatabase([{ shopId: "s", orders: [order("1")] }, { shopId: "s", orders: [order("2")] }]);
    let now = 0;
    db.$transaction.mockImplementation(async (run) => { now += 600; return run(db); });

    const result = await purgeExpiredOrders({ database: db, budgetMs: 1_000, clock: () => now });

    expect(result).toMatchObject({ ordersDeleted: 2, deliveriesDeleted: 0, complete: false });
    expect(db.webhookDelivery.deleteMany).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ receivedAt: expect.anything() }),
    }));
  });

  test("stops between batches when the worker stops", async () => {
    const db = retentionDatabase([{ shopId: "s", orders: [order("1")] }, { shopId: "s", orders: [order("2")] }]);
    let stopping = false;
    const result = await purgeExpiredOrders({ database: db, shouldStop: () => stopping, onProgress: () => { stopping = true; } });

    expect(result).toMatchObject({ ordersDeleted: 1, complete: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
