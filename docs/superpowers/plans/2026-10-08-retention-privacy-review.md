# §7 Retention, Privacy and Observability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the §7 findings from the October 2026 bug review: the retention purge can't stall, Sentry receives only what the privacy policy promises, and the small analytics and claims issues in this section.

**Architecture:** The retention purge moves from "globally oldest order first" to "one shop at a time". Each shop runs in its own batches with an explicit transaction timeout, and a failing shop is skipped and reported instead of blocking the others. The final webhook-delivery sweep runs in batches. New indexes ship as single-statement `CONCURRENTLY` migrations. `reportFailure` sends real exceptions to Sentry with a short allow-list of code-path tags. Shop, order and amount fields stay in the Railway logs, and each log line carries the Sentry event ID so the two can be matched.

**Tech Stack:** Node 22 ESM, React Router 7, Prisma 6 on PostgreSQL 17, Vitest, `@sentry/node` 11.

**Spec:** `/Users/jasonkreiss/PycharmProjects/yasas/insurance-bug-review/docs/reviews/2026-10-bug-review.md`, section "### 7. Schema, retention, privacy, observability, claims". That file is uncommitted in another worktree, so read it there and do not copy it.

## Workspace

- Work only in `/Users/jasonkreiss/PycharmProjects/yasas/insurance-retention-privacy` on branch `fix/retention-privacy-review`. It was created from `origin/main` @ 5801819 and has no upstream. **Never** edit, switch branches in, or run git commands that change `/Users/jasonkreiss/PycharmProjects/yasas/insurance`, because Codex works there concurrently.
- First step before Task 1: `cd /Users/jasonkreiss/PycharmProjects/yasas/insurance-retention-privacy && npm ci && npx prisma generate`. If `.env` is needed for tests, copy it from the main checkout (read-only copy): `cp ../insurance/.env .env 2>/dev/null || true`.
- Commit after each task. Do **not** push or open a PR; the user decides that.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run single test files with `npx vitest run <path>`. Run everything with `npm test`.

## Global Constraints

- Every merchant-owned query stays scoped by `shopId`; never drop a tenant filter.
- Changes must never block checkout. Nothing here touches the extensions.
- Never log or send to Sentry error messages, customer data, or free-text error names. `docs/privacy-policy.md` says Sentry receives "Error type, code location and deploy version only." Do **not** edit the privacy policy; make the code conform.
- Do not edit already-applied migration files (anything in `prisma/migrations/` that exists today). Add new migrations only.
- Match surrounding style: ESM, 2-space indent, double quotes, short comments that explain *why*, existing import style per file (`.js` suffixes in `app/order-*.js`, `app/shop.server.js` and `app/observability.server.js`; extensionless in `app/analytics.server.js` and `app/claims/`).
- `README.md` is the owner's concise operator reference; design detail goes in `docs/agents/`. Update docs in the same change as behavior (Task 7).

## Out of scope (decided while planning; record these in Task 7)

- `order-retention.server.js:27` (purge deletes PROCESSING deliveries → false `webhook_retry`): **NO CHANGE**. Since the §4 fixes, `app/webhook-worker.server.js` (~line 203) skips the alert when the delivery row is gone (`if (count === 0) continue;`), so a purged in-flight delivery no longer alerts. The order is past retention, so ingestion stores nothing anyway.
- `migrations/20261007020000_order_retention_index` (CREATE INDEX without CONCURRENTLY): **NO CHANGE to the file**. It may already be applied on staging, and editing applied migrations is unsafe. It is not in `production` yet. On the first production deploy it builds once on a pilot-size `Order` table, and Task 3 replaces that index with a concurrently built composite one.
- `migrations/20261006010000_disable_consumer_law_coverage` is a DUPLICATE of §3 and is handled on the §3 branch.

## Review Focus

1. **A shop whose purge batch fails every time** (trigger exception, lock timeout). Expected: every other shop is still purged. The failing shop is reported once per run, not once per one-minute turn, and is retried at the next daily run. → Task 1 test "keeps purging other shops when one shop fails", Task 2 test "skips a failed shop for the rest of the run, then retries it next run".
2. **A customer redaction deletes some of the same orders mid-purge.** Expected: counts reflect rows actually deleted, and the loop still terminates. → Task 1 test "counts orders actually deleted when a redaction got there first".
3. **Prisma applying a `CREATE INDEX CONCURRENTLY` migration.** Expected: `prisma migrate deploy` succeeds on Postgres 17, the indexes are valid, and `verify:schema` reports no drift. → Task 3 Steps 4–6.
4. **A thrown non-Error value, or an error whose `name` is free text.** Expected: Sentry gets only a class-like type, and its value is the event name. → Task 5 tests.
5. **Existing Sentry alert rules keyed on the issue title (`webhook_terminal`, `protection_price_unmatched`).** Expected: the event name is still in the issue title (as the exception value) and in an `event` tag. → Task 5 test "puts the event name in the exception value", README update in Task 7.

---

### Task 1: Per-shop retention purge with timeout, failure isolation and batched delivery sweep

Fixes: HIGH `order-retention.server.js:51` (default 5s transaction timeout; always restarts at the globally oldest order, so one slow shop stalls all), MED `order-retention.server.js:60` (unbatched final delivery delete), LOW `order-retention.server.js:29` (selected vs deleted count). Also fixes §8 LOW `verify-postgres.js:336` (purge test hit the globally oldest shop).

**Files:**
- Modify: `app/shop.server.js` (`deleteOrderRecords`, ~line 138–152 on this branch; find it with `grep -n "export async function deleteOrderRecords" app/shop.server.js`)
- Rewrite: `app/order-retention.server.js`
- Rewrite: `app/order-retention.server.test.js`
- Modify: `scripts/verify-postgres.js` (import on line 7; purge assertion ~line 351)

**Interfaces:**
- Produces:
  - `deleteOrderRecords(transaction, shopId, orderIds, shopifyOrderIds): Promise<number>`: returns the `count` from `order.deleteMany` (previously returned `undefined`).
  - `RETENTION_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 }`
  - `shopsWithExpiredOrders(database, cutoff, skipShopIds = []): Promise<string[]>`
  - `purgeExpiredShopBatch(transaction, shopId, cutoff, batchSize = RETENTION_BATCH_SIZE): Promise<{ selected: number, deleted: number }>`
  - `purgeExpiredDeliveryBatch(database, cutoff, batchSize = RETENTION_BATCH_SIZE): Promise<{ selected: number, deleted: number }>`
  - `purgeExpiredOrders({ database, now, batchSize, budgetMs, shouldStop, onProgress, onShopFailure, skipShopIds, clock }): Promise<{ cutoff: Date, ordersDeleted: number, deliveriesDeleted: number, failedShopIds: string[], complete: boolean }>`
  - `purgeExpiredOrderBatch` is **removed** (its only callers are the test file and `scripts/verify-postgres.js`, both updated here).

- [ ] **Step 1: Make `deleteOrderRecords` return the deleted order count, and fix its comment**

In `app/shop.server.js`, replace the body of `deleteOrderRecords` (keep the function's position) with:

```js
// Deletes one shop's orders and everything recorded against them, including
// webhook deliveries for those Shopify order IDs. Customer redaction and the
// retention purge share it. Returns the number of orders deleted.
export async function deleteOrderRecords(transaction, shopId, orderIds, shopifyOrderIds) {
  const ids = { in: orderIds };
  // Confirmed purchases and claim events reject ordinary deletes. Despite its
  // name, this transaction-local setting covers every privacy deletion: shop
  // redaction, customer redaction, and the 24-month retention purge.
  await transaction.$executeRawUnsafe("SET LOCAL app.allow_shop_redaction = 'on'");
  await transaction.claimEvent.deleteMany({ where: { shopId, claim: { protectionPurchase: { orderId: ids } } } });
  await transaction.claim.deleteMany({ where: { shopId, protectionPurchase: { orderId: ids } } });
  await transaction.protectionRefund.deleteMany({ where: { shopId, orderId: ids } });
  await transaction.protectionPurchase.deleteMany({ where: { shopId, orderId: ids } });
  await transaction.orderLine.deleteMany({ where: { shopId, orderId: ids } });
  const { count } = await transaction.order.deleteMany({ where: { shopId, id: ids } });
  await transaction.webhookDelivery.deleteMany({ where: { shopId, shopifyOrderId: { in: shopifyOrderIds } } });
  return count;
}
```

(This also addresses LOW `shop.server.js:87`: the reuse of the redaction bypass is now stated where it is used. Task 7 documents it.)

Run: `npx vitest run app/shop.server.test.js`. Expected: PASS (its mocks already return `{ count: 1 }`).

- [ ] **Step 2: Write the failing tests**

Replace `app/order-retention.server.test.js` entirely with:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run app/order-retention.server.test.js`
Expected: FAIL. The imports `purgeExpiredShopBatch`, `shopsWithExpiredOrders`, `purgeExpiredDeliveryBatch` and `RETENTION_TRANSACTION_OPTIONS` are undefined.

- [ ] **Step 4: Rewrite `app/order-retention.server.js`**

```js
import prisma from "./db.server.js";
import { retentionCutoff } from "./order-retention.js";
import { deleteOrderRecords } from "./shop.server.js";

export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
export const RETENTION_BATCH_SIZE = 500;
// One purge turn is time-boxed so reconciliation keeps running during a backlog.
export const RETENTION_BUDGET_MS = 60_000;
// Prisma's default 5-second interactive transaction is too short for a full
// batch on a busy database.
export const RETENTION_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 10_000 };
const FINISHED_DELIVERY = { in: ["PROCESSED", "FAILED"] };

export async function shopsWithExpiredOrders(database, cutoff, skipShopIds = []) {
  const shops = await database.shop.findMany({
    where: { id: { notIn: [...skipShopIds] }, orders: { some: { shopifyCreatedAt: { lt: cutoff } } } },
    orderBy: { id: "asc" }, select: { id: true },
  });
  return shops.map(({ id }) => id);
}

// Deletes up to batchSize of one shop's orders placed before the cutoff, with
// their lines, purchases, refunds, claims, and webhook deliveries. selected is
// what the batch found (fewer than batchSize means the shop is done); deleted
// can be lower when a customer redaction removed some first.
export async function purgeExpiredShopBatch(transaction, shopId, cutoff, batchSize = RETENTION_BATCH_SIZE) {
  const orders = await transaction.order.findMany({
    where: { shopId, shopifyCreatedAt: { lt: cutoff } },
    orderBy: [{ shopifyCreatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, shopifyOrderId: true },
  });
  if (orders.length === 0) return { selected: 0, deleted: 0 };
  const deleted = await deleteOrderRecords(transaction, shopId,
    orders.map((order) => order.id), orders.map((order) => order.shopifyOrderId));
  return { selected: orders.length, deleted };
}

// Finished deliveries received before the cutoff, even when their order was
// never stored. Deleting by id keeps each statement small.
export async function purgeExpiredDeliveryBatch(database, cutoff, batchSize = RETENTION_BATCH_SIZE) {
  const rows = await database.webhookDelivery.findMany({
    where: { receivedAt: { lt: cutoff }, status: FINISHED_DELIVERY }, select: { id: true }, take: batchSize,
  });
  if (rows.length === 0) return { selected: 0, deleted: 0 };
  const { count } = await database.webhookDelivery.deleteMany({
    where: { id: { in: rows.map(({ id }) => id) }, status: FINISHED_DELIVERY },
  });
  return { selected: rows.length, deleted: count };
}

// Purges shop by shop in short transactions, so a backlog never holds long
// locks and one shop that keeps failing can't hold back the rest: its error
// goes to onShopFailure and the run moves on. Stops when the budget runs out
// or the worker stops; complete is false then, and the next turn continues
// (pass the failed shops back as skipShopIds). Once every shop is done, old
// finished deliveries go too. onProgress runs after each batch so the worker
// stays visibly alive.
export async function purgeExpiredOrders({
  database = prisma,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
  budgetMs = RETENTION_BUDGET_MS,
  shouldStop = () => false,
  onProgress = () => {},
  onShopFailure = () => {},
  skipShopIds = [],
  clock = Date.now,
} = {}) {
  const cutoff = retentionCutoff(now);
  const deadline = clock() + budgetMs;
  const outOfTurn = () => shouldStop() || clock() >= deadline;
  const failedShopIds = [];
  let ordersDeleted = 0;
  let deliveriesDeleted = 0;
  const finish = (complete) => ({ cutoff, ordersDeleted, deliveriesDeleted, failedShopIds, complete });

  for (const shopId of await shopsWithExpiredOrders(database, cutoff, skipShopIds)) {
    try {
      for (;;) {
        if (outOfTurn()) return finish(false);
        const { selected, deleted } = await database.$transaction(
          (transaction) => purgeExpiredShopBatch(transaction, shopId, cutoff, batchSize),
          RETENTION_TRANSACTION_OPTIONS,
        );
        ordersDeleted += deleted;
        onProgress();
        if (selected < batchSize) break;
      }
    } catch (error) {
      failedShopIds.push(shopId);
      onShopFailure(shopId, error);
    }
  }
  for (;;) {
    if (outOfTurn()) return finish(false);
    const { selected, deleted } = await purgeExpiredDeliveryBatch(database, cutoff, batchSize);
    deliveriesDeleted += deleted;
    if (selected === 0) break;
    onProgress();
    if (selected < batchSize) break;
  }
  return finish(true);
}
```

Check against the first purge test: shop-a takes 2 batches and shop-b 1 batch (3 `onProgress` calls). The delivery sweep then deletes 2 (selected = batchSize, loop) and 1 (selected < batchSize, stop), which adds 2 more calls: 5 in total. Two delivery lookups. ✓

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/order-retention.server.test.js app/shop.server.test.js`
Expected: PASS.

- [ ] **Step 6: Update `scripts/verify-postgres.js`**

Change line 7 to:

```js
import { purgeExpiredDeliveryBatch, purgeExpiredShopBatch, shopsWithExpiredOrders } from "../app/order-retention.server.js";
```

Replace the single line `assert.equal(await purgeExpiredOrderBatch(transaction, new Date("2024-06-01T00:00:00.000Z")), 1);` (~line 351) with the following. It targets the fixture shop rather than whichever shop is globally oldest, and exercises the real shop and delivery queries:

```js
    const purgeCutoff = new Date("2024-06-01T00:00:00.000Z");
    assert.ok((await shopsWithExpiredOrders(transaction, purgeCutoff)).includes(otherShop.id));
    assert.ok(!(await shopsWithExpiredOrders(transaction, purgeCutoff, [otherShop.id])).includes(otherShop.id));
    assert.deepEqual(await purgeExpiredShopBatch(transaction, otherShop.id, purgeCutoff), { selected: 1, deleted: 1 });
```

Then, directly after the existing `assert.equal(await transaction.order.count({ where: { id: paidOrder.id } }), 1);` line that follows, add an old finished delivery whose order was never stored, and sweep it. The whole script runs inside a transaction that it rolls back, so nothing is kept:

```js
    const oldDelivery = await transaction.webhookDelivery.create({ data: {
      shopId: otherShop.id, shopifyOrderId: "gid://shopify/Order/8999", webhookId: "expired-orphan-delivery",
      topic: "ORDERS_PAID", status: "PROCESSED", receivedAt: expiredAt,
    } });
    const sweep = await purgeExpiredDeliveryBatch(transaction, purgeCutoff, 10_000);
    assert.ok(sweep.deleted >= 1);
    assert.equal(await transaction.webhookDelivery.count({ where: { id: oldDelivery.id } }), 0);
```

This is verified against real Postgres in Task 3 Step 6.

- [ ] **Step 7: Commit**

```bash
git add app/order-retention.server.js app/order-retention.server.test.js app/shop.server.js scripts/verify-postgres.js
git commit -m "fix: purge expired orders shop by shop with a bounded transaction and batched delivery sweep"
```

---

### Task 2: Worker skips a failed shop for the rest of the run and reports it

**Files:**
- Modify: `app/worker-runtime.server.js` (`createWorkerRuntime` state and `retentionPass`, ~lines 26–30 and 80–98)
- Modify: `app/worker-runtime.server.test.js` (retention tests ~lines 91–141)

**Interfaces:**
- Consumes: `purgeExpiredOrders` from Task 1, which accepts `skipShopIds` and `onShopFailure` and returns `failedShopIds`.
- Produces: log events `retention_purge_completed` / `retention_purge_paused`, now with a `shopsFailed` field, and a new failure report `retention_shop_failed` with `{ shopId }`.

- [ ] **Step 1: Update existing mocks and write the failing test**

In `app/worker-runtime.server.test.js`, add `failedShopIds: []` to every object returned by a `purgeOrders` mock in the three existing retention tests. There are three return values: the `async ({ onProgress })` mock, and both `mockResolvedValueOnce` values. Then add this test inside the `describe("worker runtime", ...)` block after "retries a failed purge after the backoff instead of every pass":

```js
  test("skips a failed shop for the rest of the run, then retries it next run", async () => {
    const cutoff = new Date("2024-10-07T00:00:00.000Z");
    const failure = new Error("lock timeout");
    const purgeOrders = vi.fn()
      .mockImplementationOnce(async ({ onShopFailure }) => {
        onShopFailure("shop-a", failure);
        return { cutoff, ordersDeleted: 500, deliveriesDeleted: 0, failedShopIds: ["shop-a"], complete: false };
      })
      .mockResolvedValueOnce({ cutoff, ordersDeleted: 10, deliveriesDeleted: 2, failedShopIds: [], complete: true })
      .mockResolvedValueOnce({ cutoff, ordersDeleted: 0, deliveriesDeleted: 0, failedShopIds: [], complete: true });
    const runtime = createWorkerRuntime({
      database: databaseWith([]), adminForShop: vi.fn(), purgeOrders, retentionIntervalMs: 1_000, concurrency: 1,
    });

    await runtime.retentionPass(5_000);
    await runtime.retentionPass(5_001);
    await runtime.retentionPass(6_001);

    expect(reportFailure).toHaveBeenCalledWith("retention_shop_failed", failure, { shopId: "shop-a" });
    expect(purgeOrders.mock.calls[0][0].skipShopIds).toEqual([]);
    expect(purgeOrders.mock.calls[1][0].skipShopIds).toEqual(["shop-a"]);
    expect(purgeOrders.mock.calls[2][0].skipShopIds).toEqual([]);
    expect(logEvent).toHaveBeenCalledWith("retention_purge_completed", expect.objectContaining({ ordersDeleted: 10, shopsFailed: 1 }));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/worker-runtime.server.test.js`
Expected: FAIL on the new test (`retention_shop_failed` not reported; `skipShopIds` undefined).

- [ ] **Step 3: Implement**

In `app/worker-runtime.server.js`, next to `let retentionDueAt = 0;` add:

```js
  // Shops whose purge failed this run; skipped until the run completes so one
  // shop isn't retried (and reported) every turn.
  let retentionFailedShops = new Set();
```

Replace the `try` block body of `retentionPass` with:

```js
      const result = await purgeOrders({
        database, shouldStop: () => stopping, onProgress: () => workerHeartbeat("reconciliation"),
        skipShopIds: [...retentionFailedShops],
        onShopFailure: (shopId, error) => reportFailure("retention_shop_failed", error, { shopId }),
      });
      for (const shopId of result.failedShopIds) retentionFailedShops.add(shopId);
      const shopsFailed = retentionFailedShops.size;
      if (result.complete) retentionFailedShops = new Set();
      retentionDueAt = result.complete ? now + retentionIntervalMs : now;
      logEvent(result.complete ? "retention_purge_completed" : "retention_purge_paused", {
        ordersDeleted: result.ordersDeleted, deliveriesDeleted: result.deliveriesDeleted, shopsFailed,
        cutoff: result.cutoff.toISOString(), durationMs: Date.now() - started,
      });
```

Update the comment above `retentionPass` to add: "A shop that fails is reported, skipped for the rest of the run, and retried next run."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/worker-runtime.server.test.js app/order-retention.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/worker-runtime.server.js app/worker-runtime.server.test.js
git commit -m "fix: skip and report a shop whose retention purge fails instead of stalling every shop"
```

---

### Task 3: Composite purge index and delivery sweep index, built concurrently

Fixes: MED `schema.prisma:240` (purge needs `[shopId, shopifyCreatedAt]`), MED `order-retention.server.js:60` (no `receivedAt` index), and avoids the write lock that MED `migrations/20261007020000` warned about for any new index.

**Files:**
- Modify: `prisma/schema.prisma` (`model Order` `@@index([shopifyCreatedAt])` ~line 242; `model WebhookDelivery` indexes ~line 198)
- Create: `prisma/migrations/20261009000000_order_shop_created_index/migration.sql`
- Create: `prisma/migrations/20261009000100_drop_order_created_index/migration.sql`
- Create: `prisma/migrations/20261009000200_webhook_delivery_received_index/migration.sql`

**Interfaces:**
- Produces indexes `Order_shopId_shopifyCreatedAt_idx` and `WebhookDelivery_status_receivedAt_idx`; drops `Order_shopifyCreatedAt_idx`.

- [ ] **Step 1: Update the schema**

In `model Order`, replace `@@index([shopifyCreatedAt])` with:

```prisma
  // The retention purge finds each shop's orders placed before its cutoff.
  @@index([shopId, shopifyCreatedAt])
```

In `model WebhookDelivery`, after `@@index([status, nextAttemptAt, leaseUntil])`, add:

```prisma
  // The retention purge sweeps finished deliveries received before its cutoff.
  @@index([status, receivedAt])
```

- [ ] **Step 2: Write the migrations, one statement per file**

Postgres refuses `CONCURRENTLY` inside a transaction. A multi-statement script sent as one query runs in an implicit transaction, so each file must hold exactly one statement and no `BEGIN`/`COMMIT`.

`prisma/migrations/20261009000000_order_shop_created_index/migration.sql`:

```sql
-- The retention purge finds each shop's expired orders. Built concurrently so
-- order writes continue during the deploy; this file must stay one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_shopId_shopifyCreatedAt_idx" ON "Order"("shopId", "shopifyCreatedAt");
```

`prisma/migrations/20261009000100_drop_order_created_index/migration.sql`:

```sql
-- Replaced by Order_shopId_shopifyCreatedAt_idx. One statement: CONCURRENTLY
-- cannot run inside a transaction.
DROP INDEX CONCURRENTLY IF EXISTS "Order_shopifyCreatedAt_idx";
```

`prisma/migrations/20261009000200_webhook_delivery_received_index/migration.sql`:

```sql
-- The retention purge sweeps finished deliveries received before its cutoff.
-- One statement: CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");
```

- [ ] **Step 3: Start a throwaway Postgres 17 (matches CI and Supabase)**

```bash
docker run -d --name insurance-retention-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=insurance_test -p 55432:5432 postgres:17
until docker exec insurance-retention-pg pg_isready -U postgres -d insurance_test; do sleep 1; done
export DATABASE_URL="postgresql://postgres:postgres@localhost:55432/insurance_test?schema=public"
```

(If the port or name is taken, pick another unique name and port; never reuse or stop a container you did not create.)

- [ ] **Step 4: Apply all migrations**

Run: `npx prisma generate && npx prisma migrate deploy`
Expected: all migrations applied, including the three new ones, with no error.
If it fails with `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`, Prisma is wrapping the file. In that case, remove `CONCURRENTLY` from all three files and keep `IF NOT EXISTS`. Rerun against a fresh container (`docker rm -f` it and repeat Step 3), and report this in your final summary.

- [ ] **Step 5: Confirm the indexes are valid and the schema matches the migrations**

```bash
docker exec insurance-retention-pg psql -U postgres -d insurance_test -Atc \
  "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('Order_shopId_shopifyCreatedAt_idx','WebhookDelivery_status_receivedAt_idx','Order_shopifyCreatedAt_idx') ORDER BY 1;"
npm run verify:schema
```

Expected: two rows, `Order_shopId_shopifyCreatedAt_idx|t` and `WebhookDelivery_status_receivedAt_idx|t`, and no `Order_shopifyCreatedAt_idx`. `verify:schema` exits 0.

- [ ] **Step 6: Run the Postgres verifications (also covers Task 1 Step 6)**

Run with the same `DATABASE_URL`: `npm run verify:postgres && npm run verify:webhook-postgres && npm run verify:merchant-auth-postgres`
Expected: all three pass. Keep the container running for Task 7, then remove it there.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261009000000_order_shop_created_index prisma/migrations/20261009000100_drop_order_created_index prisma/migrations/20261009000200_webhook_delivery_received_index
git commit -m "fix: index retention lookups by shop and delivery age, built concurrently"
```

---

### Task 4: Expired orders no longer block the pending-refund recheck queue

Fixes: MED `order-ingestion.server.js:83`. `persistNormalizedOrder` returns before writing for an order past retention, so its PENDING refunds' `updatedAt` never moves and they hold the front of the 20-slot recheck queue until the daily purge.

**Files:**
- Modify: `app/order-reconciliation.server.js` (imports at top; pending query ~line 226)
- Modify: `app/order-reconciliation.server.test.js` (`describe("pending refund recheck")` ~line 229)

- [ ] **Step 1: Write the failing test**

Add to the imports of `app/order-reconciliation.server.test.js`:

```js
import { retentionCutoff } from "./order-retention.js";
```

Add inside `describe("pending refund recheck", ...)`:

```js
  test("leaves out refunds on orders past retention, which are never stored again", async () => {
    const { admin } = fakeAdmin([[]]);
    const { database } = fakeDatabase();
    database.protectionRefund.findMany = vi.fn(async () => []);

    await reconcileOrders({ admin, shopDomain, database, persist: async () => {} });

    const { where } = database.protectionRefund.findMany.mock.calls[0][0];
    expect(where.order.shopifyCreatedAt.gte).toBeInstanceOf(Date);
    expect(Math.abs(where.order.shopifyCreatedAt.gte.getTime() - retentionCutoff(new Date()).getTime())).toBeLessThan(5_000);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/order-reconciliation.server.test.js -t "past retention"`
Expected: FAIL (`where.order` is undefined).

- [ ] **Step 3: Implement**

In `app/order-reconciliation.server.js` add the import (match the file's `.js` style):

```js
import { retentionCutoff } from "./order-retention.js";
```

Change the pending query's `where` to:

```js
    where: {
      shopId: shop.id, status: "PENDING",
      updatedAt: { lt: new Date(Date.now() - RECONCILIATION_INTERVAL_MS) },
      // An order past retention is never stored again, so its updatedAt would
      // never move and it would hold the front of the queue until the purge.
      order: { shopifyCreatedAt: { gte: retentionCutoff() } },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/order-reconciliation.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/order-reconciliation.server.js app/order-reconciliation.server.test.js
git commit -m "fix: keep refunds on expired orders out of the pending-refund recheck queue"
```

---

### Task 5: Sentry gets real exceptions with only code-path tags

Fixes: HIGH `observability.server.js:91` (Sentry tags carried shop domain, order IDs, fee amounts, intent), MED `observability.server.js:91` (`captureMessage` → no type or stack, so every failure of one event groups together), MED `observability.server.js:80` (`errorName` prefers the generic `"Error"` over the class name), LOW `observability.server.js:10` (`scrubEvent` kept a free-text `exception.type`).

**Files:**
- Modify: `app/observability.server.js`
- Modify: `app/observability.server.test.js`

**Interfaces:**
- `reportFailure(event, error, fields = {})` and `reportCondition(event, fields = {})` keep their signatures. All callers stay unchanged. Logs keep every field and gain `sentryEventId` when Sentry is on.
- Sentry tags are now exactly: `event`, plus `code` and `errorName` for failures, plus whichever of `topic`, `loop`, `operation` and `method` the caller passed as strings, plus the existing `service` initial-scope tag.

- [ ] **Step 1: Write the failing tests**

In `app/observability.server.test.js`:

1. Change the mock to `vi.mock("@sentry/node", () => ({ init: vi.fn(), captureMessage: vi.fn(), captureException: vi.fn(), captureCheckIn: vi.fn() }));`
2. Change the `afterEach` to:

```js
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
```

3. Add `errorName` to the import list from `./observability.server.js`.
4. Below the `PrismaClientInitializationError` class, add:

```js
// Like Shopify's API errors: a subclass that never sets name, so name is "Error".
class HttpResponseError extends Error {}
```

5. Add these tests inside `describe("failure reports", ...)`:

```js
  test("name the subclass when the error's name is the generic Error", () => {
    expect(errorName(new HttpResponseError("order #1001"))).toBe("HttpResponseError");
    expect(errorName(new Error("x"))).toBe("Error");
  });

  test("send the exception to Sentry with only code-path tags, and log its event ID", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    Sentry.captureException.mockReturnValue("evt-1");
    const logged = capture();
    const error = new HttpResponseError("order #1001 failed");

    reportFailure("webhook_retry", error, {
      shop: "one.myshopify.com", shopId: "shop-1", shopifyOrderId: "gid://shopify/Order/1001",
      chargedFeeAmount: "4.00", intent: "anything a form sent", path: "/app/claims/7", topic: "ORDERS_PAID",
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      level: "error",
      tags: { event: "webhook_retry", code: "PROCESSING_ERROR", errorName: "HttpResponseError", topic: "ORDERS_PAID" },
      fingerprint: ["{{ default }}", "webhook_retry"],
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "webhook_retry", shopId: "shop-1", sentryEventId: "evt-1" });
  });

  test("send a stand-in exception for a thrown non-Error value", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    capture();
    reportFailure("worker_loop_failed", "a string with order data", { loop: "delivery" });
    const [sent, context] = Sentry.captureException.mock.calls[0];
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toBe("worker_loop_failed");
    expect(context.tags).toEqual({ event: "worker_loop_failed", code: "PROCESSING_ERROR", errorName: "Unknown", loop: "delivery" });
  });

  test("send nothing to Sentry and log no event ID without a DSN", () => {
    vi.stubEnv("SENTRY_DSN", "");
    const logged = capture();
    reportFailure("worker_loop_failed", new Error("x"));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logged()[0]).not.toHaveProperty("sentryEventId");
  });
```

6. Add inside `describe("Sentry events", ...)`:

```js
  test("puts the event name in the exception value and drops free-text types, user and host", () => {
    const event = scrubEvent({
      tags: { event: "webhook_terminal" },
      user: { ip_address: "1.2.3.4" },
      server_name: "railway-host",
      exception: { values: [
        { type: "HttpResponseError", value: "order #1001 failed" },
        { type: "jane@example.com", value: "cause with data" },
      ] },
    });
    expect(event.exception.values).toEqual([
      { type: "HttpResponseError", value: "webhook_terminal" },
      { type: "Error", value: "webhook_terminal" },
    ]);
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("server_name");
    expect(JSON.stringify(event)).not.toContain("jane@example.com");
  });

  test("scrub the exception value when the event tag is not a plain event name", () => {
    const event = scrubEvent({ tags: { event: "order 1001 failed" }, exception: { values: [{ type: "Error", value: "x" }] } });
    expect(event.exception.values[0].value).toBe("[scrubbed]");
  });
```

7. Add inside `describe("condition reports", ...)`:

```js
  test("send Sentry only the event name, keeping shop fields in the log", () => {
    vi.stubEnv("SENTRY_DSN", "https://dsn");
    Sentry.captureMessage.mockReturnValue("evt-2");
    const logged = capture();
    reportCondition("order_sync_behind", { shopId: "shop_1", minutesBehind: 45 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith("order_sync_behind", { level: "error", tags: { event: "order_sync_behind" } });
    expect(logged()[0]).toMatchObject({ shopId: "shop_1", sentryEventId: "evt-2" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/observability.server.test.js`
Expected: FAIL on the new tests. `errorName` returns `"Error"`, `captureException` is not called, `scrubEvent` keeps the value and the free-text type, and there is no `sentryEventId`.

- [ ] **Step 3: Implement**

In `app/observability.server.js`:

a) Move the `PRISMA_CODE` and `ERROR_CLASS_NAME` constants to just below the `@sentry/node` import, and add two more beside them:

```js
const PRISMA_CODE = /^P\d{4}$/;
// Only class-like names such as PrismaClientInitializationError: never free text.
const ERROR_CLASS_NAME = /^(?:[A-Z][A-Za-z0-9]{0,62})?Error$/;
// Event names are snake_case identifiers fixed in code, e.g. webhook_terminal.
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// The privacy policy promises Sentry error type, code location and deploy
// version only. These fields name a code path from a fixed vocabulary; shop,
// order, customer and amount fields stay in the logs, which carry the Sentry
// event ID to match them up.
const SENTRY_TAG_FIELDS = ["topic", "loop", "operation", "method"];
```

b) Replace `scrubEvent` with:

```js
// Events carry only safe tags. Error messages can hold order or customer data,
// so exception text becomes the event name (which keeps issue titles such as
// "HttpResponseError: webhook_terminal") and free-text types become "Error";
// the stack still groups and locates it.
export function scrubEvent(event) {
  delete event.request;
  delete event.breadcrumbs;
  delete event.extra;
  delete event.contexts;
  delete event.user;
  delete event.server_name;
  const tag = event.tags?.event;
  const value = typeof tag === "string" && EVENT_NAME.test(tag) ? tag : "[scrubbed]";
  for (const exception of event.exception?.values ?? []) {
    exception.value = value;
    if (typeof exception.type !== "string" || !ERROR_CLASS_NAME.test(exception.type)) exception.type = "Error";
  }
  return event;
}
```

The existing test "replace exception messages but keep the type and stack" has no `tags`, so it still expects `"[scrubbed]"`. Leave it unchanged.

c) Replace `errorName` with:

```js
// The error's class, e.g. "HttpRequestError". Subclasses that never set name
// report "Error" there, so the constructor's name wins over the generic one.
// Error messages are never logged: they can contain order or customer data.
export function errorName(error) {
  if (!error || typeof error !== "object") return "Unknown";
  const names = [error.name, error.constructor?.name]
    .filter((name) => typeof name === "string" && ERROR_CLASS_NAME.test(name));
  return names.find((name) => name !== "Error") ?? "Error";
}
```

d) Add a helper and replace `reportFailure` and `reportCondition`:

```js
function sentryTags(event, fields, extra = {}) {
  const tags = { event, ...extra };
  for (const key of SENTRY_TAG_FIELDS) if (typeof fields[key] === "string") tags[key] = fields[key];
  return tags;
}

function writeError(entry, sentryEventId) {
  process.stderr.write(`${JSON.stringify({ ...entry, ...(sentryEventId ? { sentryEventId } : {}) })}\n`);
}

export function reportFailure(event, error, fields = {}) {
  const code = failureCode(error);
  const name = errorName(error);
  let sentryEventId;
  if (process.env.SENTRY_DSN) {
    // A thrown non-Error is replaced so nothing it holds is serialized. The
    // fingerprint keeps different events apart even when they share a stack.
    sentryEventId = Sentry.captureException(error instanceof Error ? error : new Error(event), {
      level: "error",
      tags: sentryTags(event, fields, { code, errorName: name }),
      fingerprint: ["{{ default }}", event],
    });
  }
  writeError({ level: "error", event, code, errorName: name, at: new Date().toISOString(), ...fields }, sentryEventId);
}

// An operator alert for a state that is not an exception, such as a sync that
// has fallen behind. Sent at error level so the same alert rules apply.
export function reportCondition(event, fields = {}) {
  const sentryEventId = process.env.SENTRY_DSN
    ? Sentry.captureMessage(event, { level: "error", tags: sentryTags(event, fields) })
    : undefined;
  writeError({ level: "error", event, at: new Date().toISOString(), ...fields }, sentryEventId);
}
```

Keep `failureCode`, `logEvent`, `sentryOptions`, the heartbeat code and their comments unchanged.

- [ ] **Step 4: Run the tests to verify they pass, and run every caller's tests**

Run: `npx vitest run app/observability.server.test.js && npm test`
Expected: PASS. If a caller's test asserted the old `errorName: "Error"` for a subclass, update that expectation to the subclass name, not the code.

- [ ] **Step 5: Commit**

```bash
git add app/observability.server.js app/observability.server.test.js
git commit -m "fix: send Sentry real exceptions with only code-path tags, matching the privacy policy"
```

---

### Task 6: Analytics history flag and claims page queries

Fixes: LOW `analytics.server.js:59` (`historyLimited` ignored the retention cutoff) and NIT `claims.server.js:8` (serial queries; `orderBy` had no tie-breaker).

**Files:**
- Modify: `app/analytics.server.js` (`sync.historyLimited` in `readShopAnalytics`)
- Modify: `app/analytics.server.test.js`
- Modify: `app/claims/claims.server.js`
- Modify: `app/claims/claims.server.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `describe("analytics database scope", ...)` in `app/analytics.server.test.js`:

```js
  test("flags history as limited for a range reaching past the retention cutoff", async () => {
    const shop = {
      id: "shop-1", orderHistoryStartAt: new Date("2024-01-01T00:00:00Z"),
      orderReconciliationSince: new Date("2026-10-07T00:00:00Z"), orderReconciliationCursor: null,
    };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue(shop) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
      protectionRefund: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const admin = { graphql: async () => ({ json: async () => ({ data: {
      shop: { currencyCode: "USD", ianaTimezone: "UTC" },
    } }) }) };
    const now = new Date("2026-10-08T12:00:00Z");
    const read = (start) => readAnalytics({ admin, shopDomain: "one.myshopify.com", database, now,
      search: new URLSearchParams(`range=custom&start=${start}&end=2026-10-01`) });

    expect((await read("2024-06-01")).sync.historyLimited).toBe(true);
    expect((await read("2024-10-08")).sync.historyLimited).toBe(false);
  });
```

Append to `app/claims/claims.server.test.js`:

```js
test("claims read Shopify, settings and claims together, newest first with a stable order", async () => {
  let claimsRead;
  const claimsStarted = new Promise((resolve) => { claimsRead = resolve; });
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", installationState: "INSTALLED", configuration: {} }) },
    claim: { findMany: vi.fn(async () => { claimsRead(); return []; }) },
  };
  // Shopify answers only once the claims query has started, so a serial read would hang.
  const admin = { graphql: vi.fn(async () => {
    await claimsStarted;
    return { json: async () => ({ data: { shop: { ianaTimezone: "UTC" } } }) };
  }) };

  await readClaimsOverview(admin, "one.myshopify.com", database);

  expect(database.claim.findMany.mock.calls[0][0].orderBy).toEqual([{ submittedAt: "desc" }, { id: "desc" }]);
}, 2_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/analytics.server.test.js app/claims/claims.server.test.js`
Expected: FAIL. The analytics test gets `false` for the 2024-06-01 start, and the claims test times out after 2s.

- [ ] **Step 3: Implement analytics**

In `app/analytics.server.js` add `import { retentionCutoff } from "./order-retention";` and change `historyLimited` to:

```js
      // Before the first backfill or the retention cutoff, orders are missing
      // locally, so totals for those dates are incomplete.
      historyLimited: !shop.orderHistoryStartAt || !shop.orderReconciliationSince || !range.start ||
        range.start < shop.orderHistoryStartAt.toISOString().slice(0, 10) ||
        range.start < retentionCutoff(now).toISOString().slice(0, 10),
```

- [ ] **Step 4: Implement claims**

In `app/claims/claims.server.js`, keep the first `shop.findUnique` and its `throw`. The existing test requires an unknown shop to be rejected before Shopify is called. Replace the three serial reads with:

```js
  // The tenant check above runs first so an unknown shop never reaches Shopify;
  // the rest are independent.
  const [data, settings, claims] = await Promise.all([
    adminGraphql(admin, `#graphql
      query ClaimsShop { shop { ianaTimezone } }
    `, {}, { shop: shopDomain }),
    getShopConfiguration(shopDomain, { database }),
    database.claim.findMany({
      where: { shopId: shop.id },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: CLAIM_LIST_LIMIT,
      select: {
        id: true, type: true, status: true, submittedAt: true,
        protectionPurchase: { select: { order: { select: { name: true, shopifyOrderId: true } } } },
      },
    }),
  ]);
```

Keep `resolveConfiguration(settings, {}, false)` and its comment after the `Promise.all`, and keep the `return` unchanged. `getShopConfiguration`'s own shop lookup stays: it enforces the INSTALLED check and creates the configuration row.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/analytics.server.test.js app/claims/claims.server.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/analytics.server.js app/analytics.server.test.js app/claims/claims.server.js app/claims/claims.server.test.js
git commit -m "fix: count the retention cutoff in analytics history and read the claims page in parallel"
```

---

### Task 7: Docs, review annotations and full verification

**Files:**
- Modify: `README.md` (retention paragraph ~lines 118–124; Sentry alerts sentence ~line 195)
- Modify: `docs/agents/data-security.md` (retention paragraph ~line 84; add a Sentry sentence where Sentry or observability is described, found with `grep -n -i "sentry\|observab" docs/agents/*.md`)
- Modify: `docs/agents/operations.md`, only if it describes Sentry tags, `captureMessage`, or the retention purge (check with grep)
- Modify (outside this repo, uncommitted file): `/Users/jasonkreiss/PycharmProjects/yasas/insurance-bug-review/docs/reviews/2026-10-bug-review.md`, §7 only

- [ ] **Step 1: README**

Replace the last two sentences of the retention paragraph ("Watch `retention_purge_completed`. … retries after an hour.") with:

```markdown
order already past it. Watch `retention_purge_completed`. A backlog runs in
one-minute turns between reconciliation passes (`retention_purge_paused`). A
shop whose purge fails is reported as `retention_shop_failed`, skipped for the
rest of that run, and retried the next day; `retention_purge_failed` (the whole
run) retries after an hour.
```

Replace the Sentry alerts sentence with:

```markdown
   Send Sentry alerts for the `event` tags `webhook_terminal` and
   `protection_price_unmatched` to the operator. Sentry carries only the error
   class, event name and code path; find the shop and order in the Railway log
   line with the same `sentryEventId`. A burst of `protection_price_unmatched` (say 3 or more in an
```

Keep the rest of that paragraph as is, and re-wrap the lines to the file's width.

- [ ] **Step 2: docs/agents/data-security.md**

In the retention paragraph, replace "Each transaction deletes up to 500 orders from one shop; each turn stops after a minute or on shutdown and continues on the next pass. A completed run also removes finished webhook deliveries received before the cutoff." with:

```markdown
It works shop by shop (`Order` index on `shopId, shopifyCreatedAt`). Each transaction deletes up to 500 of one shop's orders with a 30-second timeout, and each turn stops after a minute or on shutdown and continues on the next pass. A shop whose batch fails is reported (`retention_shop_failed`) and skipped until the next daily run, so it never holds back other shops. After every shop, finished webhook deliveries received before the cutoff are removed in batches of 500 by id. Confirmed purchases and claim events can only be deleted inside a transaction that sets `app.allow_shop_redaction`; despite its name it covers all three privacy deletions (shop redaction, `customers/redact`, and this purge). Pending refunds on orders past the cutoff are left out of the reconciliation recheck queue.
```

Where the file describes Sentry or observability, add one sentence. If it has no such section, add it at the end of the retention paragraph's section:

```markdown
Sentry receives only the error class, the event name, a stack trace, and the code-path tags `topic`, `loop`, `operation` and `method` (`app/observability.server.js`), as the privacy policy states. Shop, order and amount fields go only to the Railway logs, which record the matching `sentryEventId`.
```

- [ ] **Step 3: Annotate the review file**

In `/Users/jasonkreiss/PycharmProjects/yasas/insurance-bug-review/docs/reviews/2026-10-bug-review.md`, under each §7 finding, add an indented line in the same style as §4 (`  → FIXED (branch fix/retention-privacy-review): <one sentence>` or `  → NO CHANGE (decided 2026-10-08): <reason>`). Use the reasons from this plan's "Out of scope" section for the three NO CHANGE items. Mark the §3 duplicate `→ DUPLICATE: handled on the §3 branch.` Under §8's `verify-postgres.js:336` line, add `  → FIXED (branch fix/retention-privacy-review): the purge check now targets the fixture shop; the VERIFY_ISOLATED_DB guard is not added.` Do not change anything else in that file and do not commit there.

- [ ] **Step 4: Full verification**

With `DATABASE_URL` still pointing at the throwaway container from Task 3:

```bash
npm test && npm run lint && npm run typecheck && npm run build
npm run verify:schema && npm run verify:postgres && npm run verify:webhook-postgres && npm run verify:merchant-auth-postgres
```

Expected: all pass. If `npm run typecheck` fails because Shopify CLI typegen needs network or auth, report it and run the `tsc --noEmit` parts directly. Do not mark it as passing.

Then remove only your container: `docker rm -f insurance-retention-pg`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/agents/
git commit -m "docs: describe per-shop retention purge and Sentry tag allow-list"
```

- [ ] **Step 6: Final report**

Report: commits on `fix/retention-privacy-review`, the output summary of each verification command, and whether Prisma accepted the `CONCURRENTLY` migrations or the fallback was used. Also report one operator action for the user: **existing Sentry alert rules that match the issue message must be switched to the `event` tag**, because failures now arrive as exceptions titled `<ErrorClass>: <event>`.
