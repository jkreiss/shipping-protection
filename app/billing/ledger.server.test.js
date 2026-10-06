import { describe, expect, test, vi } from "vitest";
import { createBillingCharge, recordBillingEntries } from "./ledger.server.js";

const activatedAt = new Date("2026-10-01T00:00:00Z");
const agreement = {
  id: "agreement-1", shopId: "shop-1", mode: "NET_SHARE", status: "ACTIVE",
  rateBasisPoints: 1_000, currencyCode: "AUD", activatedAt,
};

// An in-memory stand-in for the Prisma calls the ledger makes. $queryRaw
// answers with the purchase or refund candidates its SQL asks for.
function fakeDatabase({ purchases = [], refunds = [], entries = [], charges = [], agreements = [agreement] } = {}) {
  const state = { entries: [...entries], charges: [...charges], transactions: [] };
  const database = {
    state,
    $queryRaw: vi.fn(async (strings) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "ProtectionRefund"')) return refunds;
      if (sql.includes('FROM "ProtectionPurchase"')) {
        const batch = purchases.filter((p) => !state.entries.some((e) => e.sourceId === p.sourceId));
        return batch;
      }
      throw new Error("unexpected SQL");
    }),
    billingAgreement: {
      findFirst: vi.fn(async ({ where }) => agreements.find((a) =>
        a.id === where.id && a.shopId === where.shopId && a.status === where.status) ?? null),
    },
    billingEntry: {
      createMany: vi.fn(async ({ data }) => {
        state.entries.push(...data.map((row, index) => ({ id: `entry-${state.entries.length + index}`, chargeId: null, ...row })));
        return { count: data.length };
      }),
      findMany: vi.fn(async ({ where }) => state.entries.filter((e) =>
        e.shopId === where.shopId && e.agreementId === where.agreementId && e.chargeId === null)),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = state.entries.filter((e) => where.id.in.includes(e.id) && e.shopId === where.shopId && e.chargeId === null);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    billingCharge: {
      findUnique: vi.fn(async ({ where }) => state.charges.find((c) =>
        c.agreementId === where.agreementId_periodDate.agreementId &&
        c.periodDate?.getTime() === where.agreementId_periodDate.periodDate.getTime()) ?? null),
      create: vi.fn(async ({ data }) => {
        const charge = { id: `charge-${state.charges.length + 1}`, status: "PENDING", ...data };
        state.charges.push(charge);
        return charge;
      }),
    },
    $transaction: vi.fn(async (run, options) => {
      state.transactions.push(options);
      return run(database);
    }),
  };
  return database;
}

const purchase = (id, feeAmount = "2.5000") => ({
  sourceId: id, feeAmount, currencyCode: "AUD", purchasedAt: new Date("2026-10-02T00:00:00Z"), isTest: false,
});

describe("recording billing entries", () => {
  test("enters each new paid purchase once, however often the pass runs", async () => {
    const database = fakeDatabase({ purchases: [purchase("p1"), purchase("p2", "3.0000")] });

    await expect(recordBillingEntries({ database, agreement })).resolves.toBe(2);
    await expect(recordBillingEntries({ database, agreement })).resolves.toBe(0);

    expect(database.state.entries.map(({ sourceType, sourceId, revision, amount, agreementId, shopId }) =>
      ({ sourceType, sourceId, revision, amount, agreementId, shopId }))).toEqual([
      { sourceType: "PURCHASE", sourceId: "p1", revision: 0, amount: "2.5000", agreementId: "agreement-1", shopId: "shop-1" },
      { sourceType: "PURCHASE", sourceId: "p2", revision: 0, amount: "3.0000", agreementId: "agreement-1", shopId: "shop-1" },
    ]);
    expect(database.state.transactions.every((options) => options.isolationLevel === "Serializable")).toBe(true);
  });

  test("appends a delta when a confirmed refund changes", async () => {
    const database = fakeDatabase({ refunds: [{
      sourceId: "r1", status: "CONFIRMED", amount: "1.5000", currencyCode: "AUD", isTest: false,
      entered: "-1.0000", lastRevision: 0,
    }] });

    await recordBillingEntries({ database, agreement });

    expect(database.state.entries).toEqual([expect.objectContaining({
      sourceType: "REFUND", sourceId: "r1", revision: 1, amount: "-0.5000",
    })]);
  });

  test("does not look up refunds for a gross share", async () => {
    const database = fakeDatabase({ agreements: [{ ...agreement, mode: "GROSS_SHARE" }] });
    await recordBillingEntries({ database, agreement: { ...agreement, mode: "GROSS_SHARE" } });
    expect(database.$queryRaw.mock.calls.some(([strings]) => strings.join("").includes("ProtectionRefund"))).toBe(false);
  });

  test("enters nothing once the agreement is no longer active", async () => {
    const database = fakeDatabase({ purchases: [purchase("p1")], agreements: [{ ...agreement, status: "CANCELLED" }] });
    await expect(recordBillingEntries({ database, agreement })).resolves.toBe(0);
    expect(database.state.entries).toEqual([]);
  });
});

describe("creating the daily charge", () => {
  const now = new Date("2026-10-05T13:00:00Z");
  const entry = (id, amount, chargeId = null) => ({ id, shopId: "shop-1", agreementId: "agreement-1", amount, chargeId });

  test("charges the rate on all unassigned entries and assigns them", async () => {
    const database = fakeDatabase({ entries: [entry("e1", "2.5000"), entry("e2", "3.0000"), entry("e3", "-1.0000"), entry("old", "9.0000", "charge-0")] });

    const charge = await createBillingCharge({ database, agreement, now });

    expect(charge).toMatchObject({
      shopId: "shop-1", agreementId: "agreement-1", baseAmount: "4.5000", chargeAmount: "0.4500",
      currencyCode: "AUD", periodDate: new Date("2026-10-05T00:00:00Z"),
    });
    expect(database.state.entries.filter((e) => e.chargeId === charge.id).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("creates at most one charge per agreement per day", async () => {
    const database = fakeDatabase({ entries: [entry("e1", "2.5000")] });
    await createBillingCharge({ database, agreement, now });
    database.state.entries.push(entry("e2", "5.0000"));

    await expect(createBillingCharge({ database, agreement, now: new Date("2026-10-05T23:00:00Z") })).resolves.toBeNull();
    expect(database.state.charges).toHaveLength(1);
    await expect(createBillingCharge({ database, agreement, now: new Date("2026-10-06T00:30:00Z") }))
      .resolves.toMatchObject({ chargeAmount: "0.5000" });
  });

  test("leaves a net-negative day unassigned so it offsets later revenue", async () => {
    const database = fakeDatabase({ entries: [entry("e1", "1.0000"), entry("e2", "-3.0000")] });

    await expect(createBillingCharge({ database, agreement, now })).resolves.toBeNull();
    expect(database.state.entries.every((e) => e.chargeId === null)).toBe(true);

    database.state.entries.push(entry("e3", "5.0000"));
    await expect(createBillingCharge({ database, agreement, now: new Date("2026-10-06T01:00:00Z") }))
      .resolves.toMatchObject({ baseAmount: "3.0000", chargeAmount: "0.3000" });
  });

  test("a final settlement is not limited to one per day", async () => {
    const database = fakeDatabase({ entries: [entry("e1", "2.5000")] });
    await createBillingCharge({ database, agreement, now });
    database.state.entries.push(entry("e2", "5.0000"));

    await expect(createBillingCharge({ database, agreement, now, final: true }))
      .resolves.toMatchObject({ periodDate: null, chargeAmount: "0.5000" });
  });

  test("treats a concurrent run's charge for the same day as done", async () => {
    const database = fakeDatabase({ entries: [entry("e1", "2.5000")] });
    database.billingCharge.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(createBillingCharge({ database, agreement, now })).resolves.toBeNull();
  });
});
