import { describe, expect, test } from "vitest";
import { aggregateAnalytics, analyticsRange, calendarDate } from "./analytics";

const timeZone = "Australia/Sydney";
const range = { start: "2026-09-01", end: "2026-09-30" };
const order = (changes = {}) => ({
  firstPaidAt: new Date("2026-09-01T14:30:00Z"),
  paidEligible: true, paidProtected: true, paidProtectionFee: "0.2500",
  currencyCode: "AUD", isTest: false, financialStatus: "REFUNDED", ...changes,
});
const refund = (changes = {}) => ({
  status: "CONFIRMED", amount: "0.1000", currencyCode: "AUD",
  succeededAt: new Date("2026-09-02T14:30:00Z"), order: { isTest: false }, ...changes,
});

describe("merchant analytics", () => {
  test("uses inclusive merchant calendar dates across UTC midnight", () => {
    expect(calendarDate(new Date("2026-09-01T14:30:00Z"), timeZone)).toBe("2026-09-02");
    expect(analyticsRange("range=7", timeZone, new Date("2026-09-24T01:00:00Z"))).toEqual({
      preset: "7", start: "2026-09-18", end: "2026-09-24",
    });
    expect(analyticsRange("range=custom&start=2026-09-01&end=2026-09-30", timeZone).end).toBe("2026-09-30");
  });

  test("counts paid protection once, including later cancelled or refunded orders", () => {
    const result = aggregateAnalytics({
      orders: [order(), order({ paidProtected: false }), order({ isTest: true }), order({ currencyCode: "USD" })],
      refunds: [refund(), refund({ status: "PENDING" }), refund({ status: "UNATTRIBUTED" }), refund({ currencyCode: "USD" })],
      timeZone, currencyCode: "AUD", range,
    });
    expect(result).toMatchObject({
      eligibleOrders: 2, protectedOrders: 1, hiddenTestOrders: 1, attachRate: 50,
      revenue: "0.2500", refunds: "0.1000",
      notices: { pending: 1, unattributed: 1, currencyMismatch: 2 },
    });
    expect(result.trend).toEqual([
      { date: "2026-09-02", revenue: "0.2500", refunds: "0.0000" },
      { date: "2026-09-03", revenue: "0.0000", refunds: "0.1000" },
    ]);
  });

  test("test orders appear only in preview", () => {
    const input = { orders: [order({ isTest: true })], refunds: [refund({ order: { isTest: true } })], timeZone, currencyCode: "AUD", range };
    expect(aggregateAnalytics(input)).toMatchObject({ revenue: "0.0000", hiddenTestOrders: 1 });
    expect(aggregateAnalytics({ ...input, includeTest: true })).toMatchObject({ revenue: "0.2500", hiddenTestOrders: 0 });
  });
});
