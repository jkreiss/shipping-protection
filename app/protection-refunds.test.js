import { describe, expect, test } from "vitest";
import { classifyProtectionRefund } from "./protection-refunds";

const context = {
  currencyCode: "AUD", protectionLineIds: ["protection"],
  knownLineIds: ["protection", "merchandise"], protectedOrder: true,
};
const money = (amount, currencyCode = "AUD") => ({ shopMoney: { amount, currencyCode } });
const refund = (transactions, lines = [{ lineItem: { id: "protection" }, subtotalSet: money("0.25") }]) => ({
  totalRefundedSet: money("0.25"), refundLineItems: { nodes: lines },
  transactions: { nodes: transactions },
});
const transaction = (status, amount = "0.25") => ({
  kind: "REFUND", status, amountSet: money(amount), processedAt: "2026-09-24T01:00:00Z",
});

describe("protection refund attribution", () => {
  test("counts only a fully successful protection refund", () => {
    expect(classifyProtectionRefund(refund([transaction("SUCCESS")]), context)).toEqual({
      status: "CONFIRMED", amount: "0.2500", succeededAt: new Date("2026-09-24T01:00:00Z"),
    });
    expect(classifyProtectionRefund(refund([transaction("PENDING")]), context).status).toBe("PENDING");
    expect(classifyProtectionRefund(refund([transaction("FAILURE")]), context).status).toBe("PENDING");
    expect(classifyProtectionRefund(refund([transaction("SUCCESS", "0.10")]), context).status).toBe("PENDING");
  });

  test("ignores a known merchandise-only refund and flags ambiguous lines", () => {
    const merchandise = [{ lineItem: { id: "merchandise" }, subtotalSet: money("0.25") }];
    expect(classifyProtectionRefund(refund([transaction("SUCCESS")], merchandise), context).status).toBe("IGNORED");
    expect(classifyProtectionRefund(refund([transaction("SUCCESS")], []), context).status).toBe("UNATTRIBUTED");
    expect(classifyProtectionRefund(refund([transaction("SUCCESS")], [{ lineItem: { id: "unknown" }, subtotalSet: money("0.25") }]), context).status).toBe("UNATTRIBUTED");
  });

  test("does not mix shop currencies", () => {
    const other = refund([transaction("SUCCESS")]);
    other.refundLineItems.nodes[0].subtotalSet = money("0.25", "USD");
    expect(classifyProtectionRefund(other, context).status).toBe("UNATTRIBUTED");
  });
});
