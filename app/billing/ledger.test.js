import { describe, expect, test } from "vitest";
import { describeRevenueShare, planCharge, planEntries, purchaseTarget, refundTarget } from "./ledger.js";

const activatedAt = new Date("2026-10-01T00:00:00Z");
const net = { mode: "NET_SHARE", status: "ACTIVE", rateBasisPoints: 1_000, currencyCode: "AUD", activatedAt };
const gross = { ...net, mode: "GROSS_SHARE" };
const free = { mode: "FREE", status: "ACTIVE", rateBasisPoints: 0, currencyCode: null, activatedAt };

const purchase = (overrides = {}) => ({
  sourceType: "PURCHASE", sourceId: "p1", feeAmount: "2.5000", currencyCode: "AUD",
  purchasedAt: new Date("2026-10-02T00:00:00Z"), isTest: false, entered: "0", lastRevision: -1, ...overrides,
});
const refund = (overrides = {}) => ({
  sourceType: "REFUND", sourceId: "r1", status: "CONFIRMED", amount: "1.0000", currencyCode: "AUD",
  isTest: false, entered: "0", lastRevision: -1, ...overrides,
});

describe("what a source should contribute", () => {
  test("a paid purchase after activation adds its fee", () => {
    expect(purchaseTarget(purchase(), net)).toBe(25_000n);
    expect(purchaseTarget(purchase(), gross)).toBe(25_000n);
  });

  test.each([
    ["before the merchant approved billing", { purchasedAt: new Date("2026-09-30T23:59:59Z") }],
    ["on a test order", { isTest: true }],
    ["in another currency", { currencyCode: "USD" }],
    ["not yet paid", { purchasedAt: null }],
  ])("a purchase %s adds nothing", (_name, overrides) => {
    expect(purchaseTarget(purchase(overrides), net)).toBe(0n);
  });

  test("free and inactive agreements bill nothing", () => {
    expect(purchaseTarget(purchase(), free)).toBe(0n);
    expect(purchaseTarget(purchase(), { ...net, status: "CANCELLED" })).toBe(0n);
    expect(refundTarget(refund(), free)).toBe(0n);
  });

  test("only a net share subtracts confirmed protection refunds", () => {
    expect(refundTarget(refund(), net)).toBe(-10_000n);
    expect(refundTarget(refund(), gross)).toBe(0n);
  });

  test.each([
    ["pending", { status: "PENDING" }],
    ["unattributed", { status: "UNATTRIBUTED" }],
    ["on a test order", { isTest: true }],
    ["in another currency", { currencyCode: "USD" }],
  ])("a %s refund subtracts nothing", (_name, overrides) => {
    expect(refundTarget(refund(overrides), net)).toBe(0n);
  });
});

describe("planning entries", () => {
  test("adds one entry for each new source", () => {
    expect(planEntries([purchase(), refund()], net)).toEqual([
      { sourceType: "PURCHASE", sourceId: "p1", revision: 0, amount: "2.5000", currencyCode: "AUD" },
      { sourceType: "REFUND", sourceId: "r1", revision: 0, amount: "-1.0000", currencyCode: "AUD" },
    ]);
  });

  test("adds nothing for a source that is already entered", () => {
    expect(planEntries([purchase({ entered: "2.5000", lastRevision: 0 })], net)).toEqual([]);
  });

  test("appends a delta with the next revision when a source changes", () => {
    const planned = planEntries([
      refund({ amount: "1.5000", entered: "-1.0000", lastRevision: 0 }),
      refund({ sourceId: "r2", status: "PENDING", entered: "-1.0000", lastRevision: 2 }),
    ], net);
    expect(planned).toEqual([
      { sourceType: "REFUND", sourceId: "r1", revision: 1, amount: "-0.5000", currencyCode: "AUD" },
      { sourceType: "REFUND", sourceId: "r2", revision: 3, amount: "1.0000", currencyCode: "AUD" },
    ]);
  });

  test("never enters anything for a free agreement", () => {
    expect(planEntries([purchase(), refund()], free)).toEqual([]);
  });
});

describe("planning a charge", () => {
  test("charges the rate on the net of the entries", () => {
    expect(planCharge(["2.5000", "3.0000", "-1.0000"], net))
      .toEqual({ baseAmount: "4.5000", chargeAmount: "0.4500" });
  });

  test("floors the charge to the currency's minor units", () => {
    expect(planCharge(["3.3333"], net)).toEqual({ baseAmount: "3.3333", chargeAmount: "0.3300" });
    expect(planCharge(["999.0000"], { ...net, currencyCode: "JPY" }))
      .toEqual({ baseAmount: "999.0000", chargeAmount: "99.0000" });
    expect(planCharge(["1.2345"], { ...net, currencyCode: "KWD" }))
      .toEqual({ baseAmount: "1.2345", chargeAmount: "0.1230" });
  });

  test("creates no charge when refunds outweigh revenue, so they carry forward", () => {
    expect(planCharge(["1.0000", "-2.0000"], net)).toBeNull();
    expect(planCharge(["1.0000", "-1.0000"], net)).toBeNull();
    expect(planCharge([], net)).toBeNull();
  });

  test("creates no charge that would round down to nothing", () => {
    expect(planCharge(["0.0900"], net)).toBeNull();
  });

  test("creates no charge for a free agreement", () => {
    expect(planCharge(["10.0000"], free)).toBeNull();
  });

  test("accepts Prisma decimals", () => {
    const decimal = { toFixed: (digits) => (2.5).toFixed(digits) };
    expect(planCharge([decimal], net)).toEqual({ baseAmount: "2.5000", chargeAmount: "0.2500" });
  });
});

describe("describing the terms", () => {
  test("states the rate and whether refunds are netted, in neutral words", () => {
    expect(describeRevenueShare(net)).toBe("10% of protection revenue, net of protection refunds");
    expect(describeRevenueShare({ ...gross, rateBasisPoints: 125 })).toBe("1.25% of protection revenue");
    expect(describeRevenueShare(free)).toBe("No charge");
  });
});
