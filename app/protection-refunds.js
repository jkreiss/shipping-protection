import { moneyToScaled, scaledToMoney } from "./order-normalization.js";

export function classifyProtectionRefund(refund, { currencyCode, protectionLineIds, knownLineIds, protectedOrder }) {
  const lineItems = refund.refundLineItems?.nodes ?? [];
  const protection = new Set(protectionLineIds);
  const known = new Set(knownLineIds);
  let amount = 0n;
  let unknownLine = false;
  // Refunded lines that are not protection, summed to tell whether a settled
  // refund paid back every line in full. Null when a subtotal can't be trusted.
  let otherLineCount = 0;
  let otherAmount = 0n;
  for (const item of lineItems) {
    const id = item.lineItem?.id;
    if (!id || !known.has(id)) unknownLine = true;
    const money = item.subtotalSet?.shopMoney;
    if (!protection.has(id)) {
      otherLineCount += 1;
      if (otherAmount !== null && money?.currencyCode === currencyCode) {
        otherAmount += moneyToScaled(money.amount);
      } else {
        otherAmount = null;
      }
      continue;
    }
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
  const totalRefunded = moneyToScaled(expected.amount);
  // A restock-only refund moves no money, so there is nothing to attribute.
  const stillMoving = transactions.some(
    (item) => item.kind === "REFUND" && !["SUCCESS", "FAILURE", "ERROR"].includes(item.status),
  );
  if (totalRefunded === 0n && !stillMoving) return zero;
  if (stillMoving || completed < totalRefunded) {
    return { status: "PENDING", amount: scaledToMoney(amount), succeededAt: null };
  }
  const dates = successes.map((item) => item.processedAt ?? item.createdAt).filter(Boolean).map((value) => new Date(value));
  if (dates.length !== successes.length || dates.some((date) => !Number.isFinite(date.valueOf()))) {
    return { status: "PENDING", amount: scaledToMoney(amount), succeededAt: null };
  }

  // The money refunded settles to protection exactly when only protection was
  // refunded. With other lines too, it only counts when every refunded line was
  // paid back in full; a reduced refund can't be split, so it isn't attributed.
  let confirmed = amount;
  if (otherLineCount === 0) {
    if (completed < confirmed) confirmed = completed;
  } else if (otherAmount === null || completed < amount + otherAmount) {
    return { status: "UNATTRIBUTED", amount: "0.0000", succeededAt: null };
  }
  return {
    status: "CONFIRMED",
    amount: scaledToMoney(confirmed),
    succeededAt: new Date(Math.max(...dates.map((date) => date.valueOf()))),
  };
}
