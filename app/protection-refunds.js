import { moneyToScaled, scaledToMoney } from "./order-normalization.js";

export function classifyProtectionRefund(refund, { currencyCode, protectionLineIds, knownLineIds, protectedOrder }) {
  const lineItems = refund.refundLineItems?.nodes ?? [];
  const protection = new Set(protectionLineIds);
  const known = new Set(knownLineIds);
  let amount = 0n;
  let unknownLine = false;
  for (const item of lineItems) {
    const id = item.lineItem?.id;
    if (!id || !known.has(id)) unknownLine = true;
    if (!protection.has(id)) continue;
    const money = item.subtotalSet?.shopMoney;
    if (!money || money.currencyCode !== currencyCode) return { status: "UNATTRIBUTED", amount: "0.0000", succeededAt: null };
    amount += moneyToScaled(money.amount);
  }
  const zero = { status: "IGNORED", amount: "0.0000", succeededAt: null };
  if (protectedOrder && unknownLine) return { ...zero, status: "UNATTRIBUTED" };
  if (amount <= 0n) {
    return protectedOrder && (lineItems.length === 0 || unknownLine)
      ? { ...zero, status: "UNATTRIBUTED" }
      : zero;
  }
  const expected = refund.totalRefundedSet?.shopMoney;
  if (!expected || expected.currencyCode !== currencyCode) {
    return { status: "UNATTRIBUTED", amount: "0.0000", succeededAt: null };
  }
  const transactions = refund.transactions?.nodes ?? [];
  const successes = transactions.filter((item) => item.kind === "REFUND" && item.status === "SUCCESS");
  if (successes.some((item) => item.amountSet?.shopMoney?.currencyCode !== currencyCode)) {
    return { status: "UNATTRIBUTED", amount: "0.0000", succeededAt: null };
  }
  const completed = successes.reduce((sum, item) => sum + moneyToScaled(item.amountSet.shopMoney.amount), 0n);
  if (completed < moneyToScaled(expected.amount) || completed < amount) {
    return { status: "PENDING", amount: scaledToMoney(amount), succeededAt: null };
  }
  const dates = successes.map((item) => item.processedAt ?? item.createdAt).filter(Boolean).map((value) => new Date(value));
  if (dates.length !== successes.length || dates.some((date) => !Number.isFinite(date.valueOf()))) {
    return { status: "PENDING", amount: scaledToMoney(amount), succeededAt: null };
  }
  return {
    status: "CONFIRMED",
    amount: scaledToMoney(amount),
    succeededAt: new Date(Math.max(...dates.map((date) => date.valueOf()))),
  };
}
